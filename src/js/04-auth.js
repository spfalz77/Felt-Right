// ════════════════════════════════════════════════════════════════════════════
// AUTH
// ════════════════════════════════════════════════════════════════════════════
async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pass  = document.getElementById('login-pass').value;
  if (!email || !pass) { toast('Enter email and password'); return; }
  try {
    const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
    if (error) throw error;
    me = await getProfile(data.user.id);
    if (!me) {
      const meta = data.user.user_metadata || {};
      await sb.from('users').insert({
        id: data.user.id,
        phone: meta.phone || '',
        display_name: meta.display_name || email.split('@')[0],
      });
      me = await getProfile(data.user.id);
    }
    me.email = data.user.email;
    localStorage.setItem('fr_email', email); // remember for next login
    enterApp();
  } catch(e) { toast('Sign in failed: ' + e.message); }
}

async function doSignup() {
  const name  = document.getElementById('signup-name').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const phone = document.getElementById('signup-phone').value.replace(/\D/g,'');
  const pass  = document.getElementById('signup-pass').value;
  if (!name || !email || !pass) { toast('Name, email and password are required'); return; }
  if (pass.length < 8) { toast('Password must be 8+ characters'); return; }
  const confirm = document.getElementById('signup-pass-confirm').value;
  if (pass !== confirm) { toast('Passwords do not match'); return; }
  try {
    const { data, error } = await sb.auth.signUp({
      email,
      password: pass,
      options: { data: { display_name: name, phone } }
    });
    if (error) throw error;

    if (data.session) {
      await sb.from('users').upsert({
        id: data.user.id, phone, display_name: name,
      });
      me = { id: data.user.id, display_name: name, avatar_emoji: '🃏', phone, email };
      enterApp();
    } else {
      // Email confirmation on — tell them to check email
      toast('Check your email to confirm your account, then sign in');
      switchTab('login');
      document.getElementById('login-email').value = email;
    }
  } catch(e) { toast('Sign up failed: ' + e.message); }
}

async function doForgotPassword() {
  const email = document.getElementById('login-email').value.trim();
  if (!email) { toast('Enter your email first'); return; }
  try {
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: location.origin + location.pathname,
    });
    if (error) throw error;
    toast('Password reset email sent — check your inbox');
  } catch(e) { toast('Could not send reset email: ' + e.message); }
}

async function getProfile(userId) {
  const { data } = await sb.from('users').select('*').eq('id', userId).single();
  return data;
}

