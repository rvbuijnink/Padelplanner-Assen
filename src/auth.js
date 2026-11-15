// Browserbundel voor inloggen met Netlify Identity. Wordt bij de Netlify-build
// gebundeld naar public/auth.js (zie netlify.toml) en zet alles op window.Auth.
import {
  AuthError, MissingIdentityError, getSettings, getUser, handleAuthCallback,
  login, logout, onAuthChange, recoverPassword, refreshSession,
  requestPasswordRecovery, signup, updateUser, acceptInvite
} from '@netlify/identity';

window.Auth = {
  AuthError, MissingIdentityError, getSettings, getUser, handleAuthCallback,
  login, logout, onAuthChange, recoverPassword, refreshSession,
  requestPasswordRecovery, signup, updateUser, acceptInvite
};
window.dispatchEvent(new Event('auth-klaar'));
