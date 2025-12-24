import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
from typing import Any, Dict, List, Optional, Tuple

import requests
from jsonschema import Draft202012Validator
import boto3
from botocore.config import Config


JOB_SCHEMA = {
    "type": "object",
    "properties": {
        "run_id": {"type": "string"},
        "repo": {"type": "string"},
        "issue_number": {"type": "integer"},
        "branch": {"type": "string"},
        "base_branch": {"type": "string"},
        "allowed_paths": {"type": "array", "items": {"type": "string"}},
        "callback_url": {"type": "string"},
        "agent_runtime_arn": {"type": "string"},
    },
    "required": ["run_id", "repo", "issue_number", "branch"],
    "additionalProperties": True,
}

_job_validator = Draft202012Validator(JOB_SCHEMA)


def _require_env(name: str) -> str:
    v = os.getenv(name)
    if v is None or not v.strip():
        raise RuntimeError(f"Missing env var {name}")
    return v


def _load_json(s: str, *, name: str) -> Dict[str, Any]:
    try:
        obj = json.loads(s)
    except Exception as e:
        raise RuntimeError(f"{name} is not valid JSON: {e}") from e
    if not isinstance(obj, dict):
        raise RuntimeError(f"{name} must be a JSON object")
    return obj


def _safe_token_fingerprint(token: Optional[str]) -> str:
    # Don't log secrets. Provide a tiny fingerprint to confirm secret injection.
    if not token:
        return "missing"
    token = token.strip()
    if len(token) <= 8:
        return "present(len<=8)"
    return f"present(len={len(token)},suffix=...{token[-4:]})"


def _run(
    cmd: List[str],
    *,
    cwd: Optional[str] = None,
    env: Optional[Dict[str, str]] = None,
    redact: Optional[List[str]] = None,
    timeout_s: Optional[int] = None,
) -> Tuple[int, str, str]:
    redact = redact or []

    def _redact(s: str) -> str:
        for secret in redact:
            if secret:
                s = s.replace(secret, "****")
        return s

    proc = subprocess.run(
        cmd,
        cwd=cwd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        timeout=timeout_s,
    )
    return proc.returncode, _redact(proc.stdout), _redact(proc.stderr)


def _github_headers(token: str) -> Dict[str, str]:
    return {
        "Authorization": f"Bearer {token}",
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "gaab-ui-agent-worker",
    }


def _parse_repo(repo: str) -> Tuple[str, str]:
    if "/" not in repo:
        raise RuntimeError(f"repo must be in 'owner/name' format, got: {repo}")
    owner, name = repo.split("/", 1)
    return owner, name


def _sanitize_session_id(raw: str) -> str:
    """
    AgentCore session/conversation IDs must match: [a-zA-Z0-9][a-zA-Z0-9-_]*
    """
    out = []
    for ch in raw:
        if ch.isalnum() or ch in "-_":
            out.append(ch)
        else:
            out.append("-")
    s = "".join(out).strip("-")
    if not s:
        s = "session"
    if not s[0].isalnum():
        s = "s-" + s
    return s


def _post_callback(callback_url: str, payload: Dict[str, Any]) -> None:
    try:
        requests.post(callback_url, json=payload, timeout=10).raise_for_status()
    except Exception:
        # Best-effort: do not fail the run on callback issues.
        print(json.dumps({"event": "callback_failed"}), file=sys.stderr, flush=True)


def _enforce_allowed_paths(repo_dir: str, allowed_prefixes: List[str]) -> None:
    code, out, err = _run(["git", "diff", "--name-only"], cwd=repo_dir)
    if code != 0:
        raise RuntimeError(f"git diff failed: {err.strip()}")
    changed = [l.strip() for l in out.splitlines() if l.strip()]
    if not changed:
        return
    bad: List[str] = []
    for p in changed:
        if not any(p == ap or p.startswith(ap.rstrip("/") + "/") for ap in allowed_prefixes):
            bad.append(p)
    if bad:
        raise RuntimeError(f"Guardrail violation: changed files outside allowed_paths: {bad}")


class UiTestsFailedError(RuntimeError):
    def __init__(self, *, package: str, step: str, stderr: str):
        super().__init__(f"{package}: {step} failed")
        self.package = package
        self.step = step
        self.stderr = stderr


def _run_ui_tests(repo_dir: str) -> Dict[str, Any]:
    results: Dict[str, Any] = {"ui_deployment": None, "ui_portal": None}
    for subdir_key, rel in [
        ("ui_deployment", "source/ui-deployment"),
        ("ui_portal", "source/ui-portal"),
    ]:
        workdir = os.path.join(repo_dir, rel)
        if not os.path.isdir(workdir):
            raise RuntimeError(f"Missing expected directory: {rel}")

        print(json.dumps({"event": "tests_start", "package": rel, "step": "npm_ci"}), flush=True)
        code, _, err = _run(["npm", "ci", "--no-audit", "--no-fund"], cwd=workdir, timeout_s=20 * 60)
        if code != 0:
            stderr = err[-4000:]
            results[subdir_key] = {"ok": False, "step": "npm_ci", "stderr": stderr}
            raise UiTestsFailedError(package=rel, step="npm_ci", stderr=stderr)
        print(json.dumps({"event": "tests_ok", "package": rel, "step": "npm_ci"}), flush=True)

        print(json.dumps({"event": "tests_start", "package": rel, "step": "npm_test"}), flush=True)
        code, _, err = _run(["npm", "test"], cwd=workdir, timeout_s=30 * 60)
        if code != 0:
            stderr = err[-4000:]
            results[subdir_key] = {"ok": False, "step": "npm_test", "stderr": stderr}
            raise UiTestsFailedError(package=rel, step="npm_test", stderr=stderr)
        print(json.dumps({"event": "tests_ok", "package": rel, "step": "npm_test"}), flush=True)

        results[subdir_key] = {"ok": True}
    return results


def _collect_context(repo_dir: str, allowed_paths: List[str], *, max_chars: int = 120_000) -> str:
    """
    Create a small, deterministic context blob for the agent.
    We keep this intentionally compact to avoid huge payloads.
    """
    parts: List[str] = []
    parts.append("## Repo file list (allowed paths only)\n")
    code, out, err = _run(["git", "ls-files", "--"] + allowed_paths, cwd=repo_dir)
    if code != 0:
        parts.append(f"(git ls-files failed: {err.strip()})\n")
    else:
        parts.append(out.strip() + "\n")

    def add_file(rel_path: str) -> None:
        p = os.path.join(repo_dir, rel_path)
        if not os.path.isfile(p):
            return
        try:
            with open(p, "r", encoding="utf-8") as f:
                txt = f.read()
        except Exception:
            return
        parts.append(f"\n## File: {rel_path}\n")
        parts.append(txt)

    add_file("source/ui-deployment/package.json")
    add_file("source/ui-portal/package.json")
    add_file("source/ui-deployment/vite.config.ts")
    add_file("source/ui-portal/vite.config.ts")

    blob = "\n".join(parts)
    if len(blob) > max_chars:
        blob = blob[:max_chars] + "\n\n...(truncated)\n"
    return blob


def _agentcore_invoke_text(*, agent_runtime_arn: str, user_id: str, session_id: str, input_text: str) -> str:
    """
    Invoke AgentCore runtime and return the concatenated text output.
    """
    cfg = Config(read_timeout=300, connect_timeout=10, retries={"max_attempts": 3, "mode": "standard"})
    client = boto3.client("bedrock-agentcore", config=cfg)
    payload = {
        "conversationId": session_id,
        "messageId": f"msg-{int(time.time() * 1000)}",
        "input": input_text,
        "userId": user_id,
    }
    res = client.invoke_agent_runtime(
        agentRuntimeArn=agent_runtime_arn,
        payload=json.dumps(payload).encode("utf-8"),
        contentType="application/json",
        accept="application/json",
        runtimeUserId=user_id,
        runtimeSessionId=f"{session_id}_{user_id}",
    )
    response_content = res.get("response")
    if response_content is None:
        return ""

    # StreamingBody: read all and parse "data: {json}" lines.
    if hasattr(response_content, "read"):
        txt = response_content.read().decode("utf-8", errors="replace")
    elif isinstance(response_content, (str, bytes)):
        txt = response_content.decode("utf-8", errors="replace") if isinstance(response_content, bytes) else response_content
    else:
        txt = json.dumps(response_content)

    def extract_text(o: Any) -> str:
        if o is None:
            return ""
        if isinstance(o, str):
            return o
        if isinstance(o, bytes):
            try:
                return o.decode("utf-8", errors="replace")
            except Exception:
                return str(o)
        if isinstance(o, list):
            return "".join(extract_text(x) for x in o)
        if isinstance(o, dict):
            # common patterns
            if "delta" in o:
                return extract_text(o.get("delta"))
            if "text" in o:
                return extract_text(o.get("text"))
            if "content" in o:
                return extract_text(o.get("content"))
            if "message" in o:
                return extract_text(o.get("message"))
            if "result" in o:
                return extract_text(o.get("result"))
            if "output" in o:
                return extract_text(o.get("output"))
            # fallback: scan values
            return "".join(extract_text(v) for v in o.values())
        return str(o)

    # First try: the whole payload is JSON
    try:
        obj = json.loads(txt)
        extracted = extract_text(obj).strip()
        if extracted:
            return extracted
    except Exception:
        pass

    # Second try: SSE-style "data: {json}" lines
    out_parts: List[str] = []
    for line in txt.splitlines():
        line = line.strip()
        if not line:
            continue
        if line.startswith("data: "):
            line = line[6:]
        try:
            obj = json.loads(line)
            out_parts.append(extract_text(obj))
        except json.JSONDecodeError:
            out_parts.append(line)
    return "".join(out_parts).strip()


def _extract_patch_failed_paths(stderr_text: str) -> List[str]:
    paths: List[str] = []
    for line in (stderr_text or "").splitlines():
        line = line.strip()
        if not line:
            continue
        for prefix in ["error: patch failed: ", "error: ", "patch failed: "]:
            if line.startswith(prefix):
                rest = line[len(prefix) :].strip()
                # Examples:
                # - source/ui-portal/package.json:14
                # - source/ui-portal/src/...: patch does not apply
                if ":" in rest:
                    rest = rest.split(":", 1)[0].strip()
                if rest and ("/" in rest):
                    paths.append(rest)
    # de-dupe, preserve order
    seen = set()
    out: List[str] = []
    for p in paths:
        if p not in seen:
            seen.add(p)
            out.append(p)
    return out


def _read_files_for_prompt(repo_dir: str, rel_paths: List[str], *, max_chars_per_file: int = 8000) -> str:
    parts: List[str] = []
    for rp in rel_paths:
        p = os.path.join(repo_dir, rp)
        if not os.path.isfile(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                txt = f.read()
        except Exception:
            continue
        if len(txt) > max_chars_per_file:
            txt = txt[:max_chars_per_file] + "\n...(truncated)\n"
        parts.append(f"\n## Current file: {rp}\n{txt}")
    return "\n".join(parts)


def _extract_first_json_object(text: str) -> Dict[str, Any]:
    """
    Agent must respond with exactly one JSON object (tool call or final). We try to be forgiving
    and extract the first {...} block.
    """
    t = (text or "").strip()
    if not t:
        raise RuntimeError("Empty agent response")
    start = t.find("{")
    end = t.rfind("}")
    if start == -1 or end == -1 or end <= start:
        raise RuntimeError("Agent response did not contain a JSON object")
    candidate = t[start : end + 1]
    try:
        obj = json.loads(candidate)
    except Exception as e:
        raise RuntimeError(f"Failed to parse agent JSON: {e}; sample={candidate[:500]}") from e
    if not isinstance(obj, dict):
        raise RuntimeError("Agent JSON must be an object")
    return obj


def _ensure_path_allowed(path: str, allowed_paths: List[str]) -> None:
    p = path.replace("\\", "/").lstrip("/")
    if not any(p == ap or p.startswith(ap.rstrip("/") + "/") for ap in allowed_paths):
        raise RuntimeError(f"Path not allowed: {path}")


def _tool_list_files(repo_dir: str, allowed_paths: List[str]) -> Dict[str, Any]:
    code, out, err = _run(["git", "ls-files", "--"] + allowed_paths, cwd=repo_dir)
    if code != 0:
        raise RuntimeError(f"git ls-files failed: {err.strip()}")
    files = [l.strip() for l in out.splitlines() if l.strip()]
    return {"files": files}


def _tool_read_file(repo_dir: str, allowed_paths: List[str], path: str, max_chars: int = 12000) -> Dict[str, Any]:
    _ensure_path_allowed(path, allowed_paths)
    p = os.path.join(repo_dir, path)
    if not os.path.isfile(p):
        return {"path": path, "exists": False}
    with open(p, "r", encoding="utf-8") as f:
        txt = f.read()
    if len(txt) > max_chars:
        txt = txt[:max_chars] + "\n...(truncated)\n"
    return {"path": path, "exists": True, "content": txt}


def _tool_write_file(repo_dir: str, allowed_paths: List[str], path: str, content: str) -> Dict[str, Any]:
    _ensure_path_allowed(path, allowed_paths)
    p = os.path.join(repo_dir, path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(content)
    return {"path": path, "written": True, "bytes": len(content.encode("utf-8"))}


def _tool_grep(repo_dir: str, allowed_paths: List[str], pattern: str, max_results: int = 50) -> Dict[str, Any]:
    # Use git grep within allowed paths (fast, no extra deps).
    cmd = ["git", "grep", "-n", pattern, "--"] + allowed_paths
    code, out, err = _run(cmd, cwd=repo_dir)
    if code not in (0, 1):  # 1 = no matches
        raise RuntimeError(f"git grep failed: {err.strip()}")
    lines = [l.strip() for l in out.splitlines() if l.strip()]
    return {"matches": lines[:max_results], "truncated": len(lines) > max_results}


def _tool_git_status(repo_dir: str) -> Dict[str, Any]:
    code, out, err = _run(["git", "status", "--porcelain=v1"], cwd=repo_dir)
    if code != 0:
        raise RuntimeError(f"git status failed: {err.strip()}")
    return {"porcelain": out}


def _tool_git_diff(repo_dir: str, allowed_paths: List[str], max_chars: int = 20000) -> Dict[str, Any]:
    code, out, err = _run(["git", "diff", "--"] + allowed_paths, cwd=repo_dir)
    if code != 0:
        raise RuntimeError(f"git diff failed: {err.strip()}")
    if len(out) > max_chars:
        out = out[:max_chars] + "\n...(truncated)\n"
    return {"diff": out}


def _tool_run_cmd(repo_dir: str, allowed_paths: List[str], cmd: List[str], cwd: Optional[str] = None) -> Dict[str, Any]:
    # Strict allowlist: only allow safe commands needed for UI work.
    if not cmd or not isinstance(cmd, list) or not all(isinstance(x, str) for x in cmd):
        raise RuntimeError("cmd must be an array of strings")
    allowed_prefixes = [
        ["npm", "ci"],
        ["npm", "install"],
        ["npm", "test"],
        ["git", "status"],
        ["git", "diff"],
        ["git", "add"],
    ]
    if not any(cmd[: len(p)] == p for p in allowed_prefixes):
        raise RuntimeError(f"Command not allowed: {cmd}")
    run_cwd = repo_dir if not cwd else os.path.join(repo_dir, cwd)
    if cwd:
        # Only allow running inside allowed paths
        _ensure_path_allowed(cwd, allowed_paths)
    code, out, err = _run(cmd, cwd=run_cwd, timeout_s=30 * 60)
    return {"exit_code": code, "stdout": out[-4000:], "stderr": err[-4000:]}


def _tool_git_commit(repo_dir: str, allowed_paths: List[str], message: str) -> Dict[str, Any]:
    _enforce_allowed_paths(repo_dir, allowed_paths)
    _run(["git", "add", "-A"], cwd=repo_dir)
    _enforce_allowed_paths(repo_dir, allowed_paths)
    code, out, err = _run(["git", "commit", "-m", message], cwd=repo_dir)
    if code != 0:
        return {"ok": False, "stderr": err[-2000:], "stdout": out[-2000:]}
    return {"ok": True}


def _tool_git_push(repo_dir: str, token: str, repo: str, branch: str) -> Dict[str, Any]:
    owner, name = _parse_repo(repo)
    remote_url = f"https://x-access-token:{token}@github.com/{owner}/{name}.git"
    _run(["git", "remote", "set-url", "origin", remote_url], cwd=repo_dir, redact=[token])
    code, out, err = _run(["git", "push", "-u", "origin", branch], cwd=repo_dir, redact=[token], timeout_s=10 * 60)
    if code != 0:
        return {"ok": False, "stderr": err[-2000:], "stdout": out[-2000:]}
    return {"ok": True}


def _agent_tool_loop(
    *,
    agent_runtime_arn: str,
    repo_dir: str,
    token: str,
    repo: str,
    issue_number: int,
    issue_title: str,
    issue_body: str,
    branch: str,
    base_branch: str,
    allowed_paths: List[str],
    feedback: Optional[str] = None,
    max_steps: int = 25,
) -> Dict[str, Any]:
    """
    Run a simple agent-driven loop where the agent emits JSON tool calls and the worker executes them.
    """
    session_id = _sanitize_session_id(f"{repo}-issue-{issue_number}")
    history: List[Dict[str, Any]] = []

    tool_spec = {
        "tools": [
            {"name": "list_files", "args": {}},
            {"name": "read_file", "args": {"path": "string"}},
            {"name": "write_file", "args": {"path": "string", "content": "string"}},
            {"name": "grep", "args": {"pattern": "string"}},
            {"name": "git_status", "args": {}},
            {"name": "git_diff", "args": {}},
            {"name": "run_cmd", "args": {"cmd": ["string"], "cwd": "string(optional)"}},
            {"name": "git_commit", "args": {"message": "string"}},
            {"name": "final", "args": {"summary": "string"}},
        ],
        "rules": [
            "Respond with EXACTLY ONE JSON object.",
            "Either {\"type\":\"tool_call\",\"tool\":\"...\",\"args\":{...}} or {\"type\":\"final\",\"summary\":\"...\"}.",
            f"Never edit files outside allowed_paths: {allowed_paths}",
            "Prefer small steps: read before write; keep diffs minimal.",
            "Do NOT push or create PRs; the worker will do that after all tests pass.",
            "If npm ci fails because package.json and package-lock.json are out of sync, fix it by running `npm install --package-lock-only` in the failing package directory, then commit the lockfile.",
        ],
    }

    for step in range(1, max_steps + 1):
        context = _collect_context(repo_dir, allowed_paths, max_chars=60000)
        parts: List[str] = []
        parts.append("You are an autonomous UI engineer agent.\n")
        parts.append("You are driving tools hosted by the worker. You MUST follow the tool protocol.\n\n")
        parts.append(f"Allowed paths: {allowed_paths}\n")
        parts.append(f"Repo: {repo}\nBranch: {branch} (base: {base_branch})\n")
        parts.append(f"Issue #{issue_number}: {issue_title}\n\n")
        parts.append(f"Issue body:\n{issue_body}\n\n")
        if feedback:
            parts.append(f"Build/Test feedback to address:\n{feedback}\n\n")
        parts.append(f"Tool spec:\n{json.dumps(tool_spec)}\n\n")
        parts.append(f"Recent tool history (most recent last):\n{json.dumps(history[-6:])}\n\n")
        parts.append(f"Repo context:\n{context}\n")
        prompt = "".join(parts)

        raw = _agentcore_invoke_text(
            agent_runtime_arn=agent_runtime_arn,
            user_id="ui-agent-worker",
            session_id=session_id,
            input_text=prompt,
        )
        obj = _extract_first_json_object(raw)

        if obj.get("type") == "final":
            return {"status": "final", "summary": str(obj.get("summary") or "")}

        if obj.get("type") != "tool_call":
            history.append({"step": step, "error": "invalid_agent_message", "raw_sample": raw[:300]})
            continue

        tool = obj.get("tool")
        args = obj.get("args") or {}
        if not isinstance(tool, str) or not isinstance(args, dict):
            history.append({"step": step, "error": "invalid_tool_call", "raw": obj})
            continue

        print(json.dumps({"event": "agent_tool_call", "step": step, "tool": tool}), flush=True)

        try:
            if tool == "list_files":
                result = _tool_list_files(repo_dir, allowed_paths)
            elif tool == "read_file":
                result = _tool_read_file(repo_dir, allowed_paths, path=str(args.get("path") or ""))
            elif tool == "write_file":
                result = _tool_write_file(repo_dir, allowed_paths, path=str(args.get("path") or ""), content=str(args.get("content") or ""))
            elif tool == "grep":
                result = _tool_grep(repo_dir, allowed_paths, pattern=str(args.get("pattern") or ""))
            elif tool == "git_status":
                result = _tool_git_status(repo_dir)
            elif tool == "git_diff":
                result = _tool_git_diff(repo_dir, allowed_paths)
            elif tool == "run_cmd":
                result = _tool_run_cmd(
                    repo_dir,
                    allowed_paths,
                    cmd=args.get("cmd") if isinstance(args.get("cmd"), list) else [],
                    cwd=args.get("cwd") if isinstance(args.get("cwd"), str) else None,
                )
            elif tool == "git_commit":
                result = _tool_git_commit(repo_dir, allowed_paths, message=str(args.get("message") or f"agent: issue #{issue_number}"))
            else:
                result = {"error": f"unknown_tool: {tool}"}
        except Exception as e:
            result = {"error": str(e)}

        history.append({"step": step, "tool": tool, "args": args, "result": result})

        # If tool was create_pr and succeeded, we still continue until agent finalizes.

    return {"status": "max_steps_exceeded", "summary": "Agent did not finish within step limit."}


def _git_clone_and_checkout(
    *,
    token: str,
    repo: str,
    base_branch: str,
    branch: str,
    run_id: str,
) -> str:
    owner, name = _parse_repo(repo)
    remote_url = f"https://x-access-token:{token}@github.com/{owner}/{name}.git"

    work_root = tempfile.mkdtemp(prefix=f"ui-agent-{run_id}-")
    repo_dir = os.path.join(work_root, name)

    env = dict(os.environ)
    env["GIT_TERMINAL_PROMPT"] = "0"

    print(json.dumps({"event": "git_clone_start", "repo": repo, "base_branch": base_branch}), flush=True)
    code, _, err = _run(
        ["git", "clone", "--no-tags", "--branch", base_branch, remote_url, repo_dir],
        env=env,
        redact=[token],
        timeout_s=10 * 60,
    )
    if code != 0:
        raise RuntimeError(f"git clone failed: {err.strip()}")
    print(json.dumps({"event": "git_clone_ok"}), flush=True)

    _run(["git", "config", "user.email", "ui-agent@gaab.local"], cwd=repo_dir)
    _run(["git", "config", "user.name", "GAAB UI Agent"], cwd=repo_dir)
    _run(["git", "remote", "set-url", "origin", remote_url], cwd=repo_dir, redact=[token])

    code, out, _ = _run(["git", "ls-remote", "--heads", "origin", branch], cwd=repo_dir, redact=[token])
    if code != 0:
        raise RuntimeError("git ls-remote failed")

    if out.strip():
        print(json.dumps({"event": "git_branch_exists", "branch": branch}), flush=True)
        code, _, err = _run(["git", "fetch", "origin", branch], cwd=repo_dir, redact=[token])
        if code != 0:
            raise RuntimeError(f"git fetch branch failed: {err.strip()}")
        code, _, err = _run(["git", "checkout", "-B", branch, f"origin/{branch}"], cwd=repo_dir)
        if code != 0:
            raise RuntimeError(f"git checkout existing branch failed: {err.strip()}")
    else:
        print(json.dumps({"event": "git_branch_create", "branch": branch}), flush=True)
        code, _, err = _run(["git", "checkout", "-b", branch], cwd=repo_dir)
        if code != 0:
            raise RuntimeError(f"git checkout -b failed: {err.strip()}")

    return repo_dir


def _github_get_issue(token: str, repo: str, issue_number: int) -> Dict[str, Any]:
    owner, name = _parse_repo(repo)
    url = f"https://api.github.com/repos/{owner}/{name}/issues/{issue_number}"
    r = requests.get(url, headers=_github_headers(token), timeout=20)
    r.raise_for_status()
    return r.json()


def _github_find_open_pr_for_branch(token: str, repo: str, branch: str) -> Optional[Dict[str, Any]]:
    owner, name = _parse_repo(repo)
    url = f"https://api.github.com/repos/{owner}/{name}/pulls"
    r = requests.get(url, headers=_github_headers(token), params={"state": "open", "head": f"{owner}:{branch}"}, timeout=20)
    r.raise_for_status()
    prs = r.json()
    return prs[0] if prs else None


def _github_create_pr(token: str, repo: str, *, title: str, body: str, head: str, base: str) -> Dict[str, Any]:
    owner, name = _parse_repo(repo)
    url = f"https://api.github.com/repos/{owner}/{name}/pulls"
    r = requests.post(
        url,
        headers=_github_headers(token),
        json={"title": title, "body": body, "head": head, "base": base},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def main() -> int:
    job_raw = _require_env("JOB_JSON")
    job = _load_json(job_raw, name="JOB_JSON")

    errors = sorted(_job_validator.iter_errors(job), key=lambda e: e.path)
    if errors:
        raise RuntimeError("JOB_JSON failed schema validation: " + "; ".join([e.message for e in errors]))

    # Secrets Manager injection (see UiAgentRunnerStack container secrets)
    gh_pat_json_raw = os.getenv("GITHUB_PAT_JSON", "").strip()
    gh_pat_obj: Dict[str, Any] = {}
    if gh_pat_json_raw:
        gh_pat_obj = _load_json(gh_pat_json_raw, name="GITHUB_PAT_JSON")
    token = gh_pat_obj.get("token") if isinstance(gh_pat_obj, dict) else None
    if not isinstance(token, str) or not token.strip():
        raise RuntimeError("GITHUB_PAT_JSON.token missing/empty")

    base_branch = str(job.get("base_branch") or "main")
    allowed_paths = job.get("allowed_paths") or ["source/ui-deployment", "source/ui-portal"]
    if not isinstance(allowed_paths, list) or not all(isinstance(x, str) for x in allowed_paths):
        raise RuntimeError("allowed_paths must be an array of strings")
    callback_url = job.get("callback_url")
    callback_url = callback_url if isinstance(callback_url, str) and callback_url.strip() else None
    agent_runtime_arn = job.get("agent_runtime_arn")
    agent_runtime_arn = agent_runtime_arn if isinstance(agent_runtime_arn, str) and agent_runtime_arn.strip() else None

    run_id = str(job["run_id"])
    repo = str(job["repo"])
    issue_number = int(job["issue_number"])
    branch = str(job["branch"])
    job_feedback = str(job.get("feedback") or "").strip()

    print(
        json.dumps(
            {
                "event": "ui_agent_worker_start",
                "run_id": run_id,
                "repo": repo,
                "issue_number": issue_number,
                "branch": branch,
                "base_branch": base_branch,
                "allowed_paths": allowed_paths,
                "github_pat": _safe_token_fingerprint(token),
            }
        ),
        flush=True,
    )

    if callback_url:
        _post_callback(
            callback_url,
            {"status": "started", "run_id": run_id, "repo": repo, "issue_number": issue_number, "branch": branch},
        )

    repo_dir: Optional[str] = None
    work_root: Optional[str] = None
    try:
        print(json.dumps({"event": "github_issue_fetch_start"}), flush=True)
        issue = _github_get_issue(token, repo, issue_number)
        print(json.dumps({"event": "github_issue_fetch_ok"}), flush=True)
        issue_title = str(issue.get("title") or f"Issue {issue_number}")

        repo_dir = _git_clone_and_checkout(
            token=token,
            repo=repo,
            base_branch=base_branch,
            branch=branch,
            run_id=run_id,
        )
        work_root = os.path.dirname(repo_dir)

        # Agent-driven tool loop (Option 1): agent emits tool calls, worker executes.
        tests: Dict[str, Any] = {}
        last_test_failure: Optional[UiTestsFailedError] = None
        max_fix_attempts = int(os.environ.get("UI_AGENT_MAX_FIX_ATTEMPTS", "3"))
        for fix_attempt in range(1, max_fix_attempts + 1):
            if agent_runtime_arn:
                feedback_parts: List[str] = []
                if job_feedback:
                    feedback_parts.append(f"External feedback (e.g., PR review comments):\n{job_feedback}")
                if last_test_failure:
                    feedback_parts.append(
                        f"Previous attempt failed tests at {last_test_failure.package} {last_test_failure.step}.\n"
                        f"stderr:\n{last_test_failure.stderr}\n"
                    )
                combined_feedback = "\n\n".join(feedback_parts).strip() or None

                print(json.dumps({"event": "agent_tool_loop_start", "fix_attempt": fix_attempt}), flush=True)
                loop_res = _agent_tool_loop(
                    agent_runtime_arn=agent_runtime_arn,
                    repo_dir=repo_dir,
                    token=token,
                    repo=repo,
                    issue_number=issue_number,
                    issue_title=issue_title,
                    issue_body=str(issue.get("body") or ""),
                    branch=branch,
                    base_branch=base_branch,
                    allowed_paths=allowed_paths,
                    feedback=combined_feedback,
                )
                print(json.dumps({"event": "agent_tool_loop_end", "fix_attempt": fix_attempt, "result": loop_res.get("status")}), flush=True)

            print(json.dumps({"event": "guardrails_check_start", "fix_attempt": fix_attempt}), flush=True)
            _enforce_allowed_paths(repo_dir, allowed_paths)
            print(json.dumps({"event": "guardrails_check_ok", "fix_attempt": fix_attempt}), flush=True)

            print(json.dumps({"event": "tests_all_start", "fix_attempt": fix_attempt}), flush=True)
            try:
                tests = _run_ui_tests(repo_dir)
                print(json.dumps({"event": "tests_all_ok", "fix_attempt": fix_attempt}), flush=True)
                last_test_failure = None
                break
            except UiTestsFailedError as e:
                last_test_failure = e
                print(
                    json.dumps(
                        {
                            "event": "tests_all_failed",
                            "fix_attempt": fix_attempt,
                            "package": e.package,
                            "step": e.step,
                        }
                    ),
                    flush=True,
                )
                if fix_attempt == max_fix_attempts:
                    raise

        code, out, err = _run(["git", "status", "--porcelain"], cwd=repo_dir)
        if code != 0:
            raise RuntimeError(f"git status failed: {err.strip()}")
        has_worktree_changes = bool(out.strip())

        # Detect no-op: no worktree changes AND no diff vs base branch.
        # If HEAD equals origin/base_branch, PR creation would 422 ("No commits").
        code, _, err = _run(["git", "diff", "--quiet", f"origin/{base_branch}..HEAD"], cwd=repo_dir)
        if code not in (0, 1):
            raise RuntimeError(f"git diff base..HEAD failed: {err.strip()}")
        has_commit_diff_vs_base = code == 1

        if (not has_worktree_changes) and (not has_commit_diff_vs_base):
            payload = {
                "status": "no_changes",
                "run_id": run_id,
                "repo": repo,
                "issue_number": issue_number,
                "branch": branch,
                "test_summary": tests,
            }
            if callback_url:
                _post_callback(callback_url, payload)
            print(json.dumps({"event": "ui_agent_worker_no_changes", "payload": payload}), flush=True)
            return 0

        if has_worktree_changes:
            _run(["git", "add", "-A"], cwd=repo_dir)
            _enforce_allowed_paths(repo_dir, allowed_paths)
            commit_msg = f"agent: issue #{issue_number}"
            code, _, err = _run(["git", "commit", "-m", commit_msg], cwd=repo_dir)
            if code != 0:
                raise RuntimeError(f"git commit failed: {err.strip()}")

        code, _, err = _run(["git", "push", "-u", "origin", branch], cwd=repo_dir, redact=[token], timeout_s=10 * 60)
        if code != 0:
            raise RuntimeError(f"git push failed: {err.strip()}")

        pr = _github_find_open_pr_for_branch(token, repo, branch)
        if not pr:
            pr = _github_create_pr(
                token,
                repo,
                title=f"Agent: {issue_title}",
                body=f"Fixes #{issue_number}\n\nAutomated changes by GAAB UI Agent.",
                head=branch,
                base=base_branch,
            )

        payload = {
            "status": "pr_created",
            "run_id": run_id,
            "repo": repo,
            "issue_number": issue_number,
            "branch": branch,
            "pr_url": pr.get("html_url"),
            "pr_number": pr.get("number"),
            "test_summary": tests,
        }
        if callback_url:
            _post_callback(callback_url, payload)
        print(json.dumps({"event": "ui_agent_worker_done", "payload": payload}), flush=True)
        return 0
    except Exception as e:
        # Best-effort callback so n8n can post failure info back to GitHub.
        if callback_url:
            try:
                _post_callback(
                    callback_url,
                    {
                        "status": "failed",
                        "run_id": run_id,
                        "repo": repo,
                        "issue_number": issue_number,
                        "branch": branch,
                        "error": str(e),
                    },
                )
            except Exception:
                pass
        raise
    finally:
        if work_root and os.path.isdir(work_root):
            shutil.rmtree(work_root, ignore_errors=True)

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as e:
        print(json.dumps({"event": "ui_agent_worker_error", "error": str(e)}), file=sys.stderr, flush=True)
        sys.exit(1)


