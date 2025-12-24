import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@/portal/theme/ThemeProvider';
import { LoginPage } from '@/portal/pages/LoginPage';

vi.mock('aws-amplify', () => ({
  Auth: {
    signIn: vi.fn(),
    completeNewPassword: vi.fn()
  }
}));

function renderLogin() {
  return render(
    <ThemeProvider>
      <MemoryRouter>
        <LoginPage />
      </MemoryRouter>
    </ThemeProvider>
  );
}

describe('LoginPage', () => {
  it('renders username/password fields', () => {
    renderLogin();
    expect(screen.getByLabelText('Username')).toBeInTheDocument();
    expect(screen.getByLabelText('Password')).toBeInTheDocument();
  });

  it('toggles password visibility', async () => {
    const user = userEvent.setup();
    renderLogin();

    const password = screen.getByLabelText('Password') as HTMLInputElement;
    expect(password.type).toBe('password');

    const passwordWrapper = password.parentElement;
    expect(passwordWrapper).not.toBeNull();
    await user.click(within(passwordWrapper as HTMLElement).getAllByLabelText('Show password')[0]);
    expect(password.type).toBe('text');

    await user.click(within(passwordWrapper as HTMLElement).getAllByLabelText('Hide password')[0]);
    expect(password.type).toBe('password');
  });
});


