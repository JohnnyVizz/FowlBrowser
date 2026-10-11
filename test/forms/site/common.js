// Shared by every form: inline errors with a summary, and the submit that swaps the page for its success view.
export function showErrors(errors, summaryHost) {
  clearErrors();
  if (!Object.keys(errors).length) return true;
  for (const [name, message] of Object.entries(errors)) {
    const field = document.querySelector(`[data-field="${name}"]`);
    if (!field) continue;
    const p = document.createElement('p');
    p.className = 'error'; p.id = `err-${name}`; p.textContent = message;
    field.append(p);
    const control = field.querySelector('input:not([type=hidden]), select, textarea, [contenteditable], [role=listbox], [role=combobox]');
    if (control) { control.setAttribute('aria-invalid', 'true'); control.setAttribute('aria-describedby', p.id); }
  }
  const box = document.createElement('div');
  box.className = 'summary'; box.id = 'error-summary'; box.setAttribute('role', 'alert');
  box.innerHTML = '<strong>Please fix the following:</strong><ul></ul>';
  for (const message of Object.values(errors)) box.querySelector('ul').append(Object.assign(document.createElement('li'), { textContent: message }));
  (summaryHost || document.querySelector('main')).prepend(box);
  return false;
}

export function clearErrors() {
  document.querySelectorAll('.error, #error-summary').forEach((e) => e.remove());
  document.querySelectorAll('[aria-invalid]').forEach((e) => e.removeAttribute('aria-invalid'));
}

export const emailOk = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

export async function submit(form, payload, host = document.querySelector('main')) {
  const res = await fetch(`/submit/${form}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
  const { id } = await res.json();
  host.innerHTML = `<div class="success" role="status"><h1>Thanks, it's submitted</h1><p>Keep this for your records.</p><p class="sid">Submission id: <span id="submission-id">${id}</span></p></div>`;
  document.title = `Submitted ${id}`;
  return id;
}
