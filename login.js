const form = document.querySelector('#loginForm');
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const error = document.querySelector('#error');
  error.textContent = '';
  try {
    const res = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.querySelector('#password').value }) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'ورود ناموفق بود.');
    location.href = '/';
  } catch (err) { error.textContent = err.message; }
});
