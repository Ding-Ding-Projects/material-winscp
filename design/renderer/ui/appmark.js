// One application identity for every renderer surface. The SVG is bundled
// with the app and is decorative wherever adjacent text already names it.
import { h } from '../dom.js';

export const APP_MARK_URL = new URL('../../assets/app-logo.svg', import.meta.url).href;

export function appMark(className = '') {
  return h('img', {
    class: className,
    src: APP_MARK_URL,
    alt: '',
    'aria-hidden': 'true',
    draggable: 'false',
  });
}
