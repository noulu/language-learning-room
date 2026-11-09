// Visual changes never delay learning actions or keep retired controls active.
let ghost = null;
const running = new Set();
const reduced = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
function clearMotion() {
  for (const animation of running) animation.cancel();
  running.clear(); ghost?.remove(); ghost = null;
}
function fade(element, from, to, duration) {
  if (!element?.animate || reduced()) return;
  const animation = element.animate([{ opacity: from }, { opacity: to }], { duration, easing: 'ease-out' });
  running.add(animation);
  animation.finished.then(() => running.delete(animation), () => running.delete(animation));
  return animation;
}
function snapshot(element) {
  if (!element || reduced() || !element.animate) return null;
  const bounds = element.getBoundingClientRect();
  if (bounds.bottom <= 0 || bounds.top >= innerHeight) return null;
  const copy = element.cloneNode(true);
  const styles = getComputedStyle(element);
  copy.classList.add('practice-ghost'); copy.setAttribute('aria-hidden', 'true'); copy.inert = true;
  Object.assign(copy.style, {
    position: 'fixed', left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px`,
    minHeight: '0', margin: '0', gridTemplateRows: styles.gridTemplateRows, opacity: '1',
  });
  // A visual copy must not replay media, create duplicate IDs or accept focus.
  copy.querySelectorAll('audio,video,source').forEach(node => node.remove());
  for (const node of [copy, ...copy.querySelectorAll('[id]')]) {
    const original = node.id && document.getElementById(node.id);
    if (original) node.style.minHeight = getComputedStyle(original).minHeight;
    node.removeAttribute('id'); node.removeAttribute('autofocus');
  }
  copy.querySelectorAll('button,input,textarea,select,a').forEach(node => node.setAttribute('tabindex', '-1'));
  return copy;
}
function retire(copy) {
  if (!copy) return;
  ghost = copy; document.body.append(copy);
  const animation = fade(copy, 1, 0, 100);
  if (!animation) { copy.remove(); ghost = null; return; }
  animation.finished.then(() => { copy.remove(); if (ghost === copy) ghost = null; }, () => copy.remove());
}
function patch(current, next) {
  if (current.isEqualNode(next)) return;
  if (current.nodeType !== next.nodeType || current.nodeName !== next.nodeName) { current.replaceWith(next); return; }
  if (current.nodeType === Node.TEXT_NODE) { current.textContent = next.textContent; return; }
  if (current.nodeType !== Node.ELEMENT_NODE) { current.replaceWith(next); return; }
  for (const attribute of [...current.attributes]) if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  for (const attribute of next.attributes) if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  // Keep the live draft, selection and composition while the same task updates.
  if (current === document.activeElement && current.matches('input,textarea')) return;
  const children = [...next.childNodes];
  for (let index = 0; index < children.length; index++) {
    if (current.childNodes[index]) patch(current.childNodes[index], children[index]);
    else current.append(children[index]);
  }
  while (current.childNodes.length > children.length) current.lastChild.remove();
}
export function renderPracticeMarkup(root, markup, key, revealed, scope) {
  const previousKey = root.dataset.motionKey, wasRevealed = root.dataset.motionRevealed === 'true';
  const sameTask = Boolean(key && key === previousKey);
  clearMotion();
  const template = document.createElement('template'); template.innerHTML = markup;
  if (sameTask) {
    const next = root.cloneNode(false); next.append(template.content);
    patch(root, next);
  } else root.replaceChildren(template.content);
  root.dataset.motionKey = key || ''; root.dataset.motionRevealed = String(revealed);
  root.dataset.motionScope = scope;
  if (sameTask && revealed && !wasRevealed) {
    root.querySelectorAll('.answer, .word-example, .word-mnemonic, .mnemonic-pending, .ratings').forEach(node => fade(node, .82, 1, 80));
  }
}
export function renderExampleMarkup(element, markup) {
  if (!element) return;
  // An arriving example must not interrupt the meaning's ongoing fade.
  if (ghost) { for (const animation of ghost.getAnimations()) animation.cancel(); ghost.remove(); ghost = null; }
  for (const animation of element.getAnimations()) { animation.cancel(); running.delete(animation); }
  const outgoing = snapshot(element);
  element.innerHTML = markup; retire(outgoing); fade(element, .45, 1, 160);
}
