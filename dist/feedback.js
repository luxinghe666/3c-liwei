// Shared feedback for native form controls. No business mutation or synthetic success.
export function beginButtonFeedback(button, label) {
  if (!button) return () => {};
  const text = button.textContent;
  const disabled = button.disabled;
  const ariaBusy = button.getAttribute('aria-busy');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  if (label) button.textContent = label;
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    button.disabled = disabled;
    if (ariaBusy === null) button.removeAttribute('aria-busy');
    else button.setAttribute('aria-busy', ariaBusy);
    // A correction preview may change the CTA; do not overwrite its next step.
    if (label && button.textContent === label) button.textContent = text;
  };
}

export const confirmationCheckbox = (name, label, detail) => `
  <label class="galaxy-check-card">
    <input type="checkbox" name="${name}" required>
    <span class="galaxy-checkmark" aria-hidden="true"></span>
    <span class="galaxy-check-copy"><strong>${label}</strong><small>${detail}</small></span>
  </label>`;
