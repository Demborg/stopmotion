const TOAST_DURATION_MS = 2500;

export const $ = (id) => document.getElementById(id);

export const store = {
  get: (key, fallback) => JSON.parse(localStorage.getItem('stopmo.' + key)) ?? fallback,
  set: (key, value) => localStorage.setItem('stopmo.' + key, JSON.stringify(value)),
};

let toastTimer;
export function toast(text, durationMs = TOAST_DURATION_MS) {
  const box = $('toast');
  box.textContent = text;
  box.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { box.hidden = true; }, durationMs);
}

export function showMessage(text, action) {
  const box = $('message');
  box.replaceChildren();
  box.hidden = !text;
  if (!text) return;
  const paragraph = document.createElement('p');
  paragraph.textContent = text;
  box.append(paragraph);
  if (action) {
    const button = document.createElement('button');
    button.textContent = action.label;
    button.onclick = action.run;
    box.append(button);
  }
}

export function flash() {
  const overlay = $('flash');
  overlay.classList.remove('go');
  void overlay.offsetWidth;
  overlay.classList.add('go');
}

export function setStatus([text, tone]) {
  $('b-status').textContent = text;
  $('b-status').className = 'status ' + tone;
}
