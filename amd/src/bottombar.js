// This file is part of Moodle - http://moodle.org/
//
// Moodle is free software: you can redistribute it and/or modify
// it under the terms of the GNU General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// Moodle is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU General Public License for more details.
//
// You should have received a copy of the GNU General Public License
// along with Moodle.  If not, see <http://www.gnu.org/licenses/>.

/**
 * Keeps the studio's controls clear of the bars fixed to the window: the site's top bar (the navbar, with the course
 * index button) and a bar fixed to the bottom, such as Moodle 5.3's activity navigation footer (Previous, Back to
 * course, Next). A control under one of them cannot be clicked: the click lands on the bar, and the focus stays where
 * it was. The bottom bar's height is set on the studio as --mod-vrmakerspace-bottombar (the 3D view is made that much
 * shorter); a control that takes the focus, an opened menu and the tour's bubble are scrolled between the bars, and
 * the tools start just below the top bar. The approach is the one mod_talkwithai's conversation page uses.
 *
 * @module     mod_vrmakerspace/bottombar
 * @copyright  2026 Adam Jenkins <adam@wisecat.net>
 * @license    http://www.gnu.org/copyleft/gpl.html GNU GPL v3 or later
 */

/** Space kept between a control and the bar (px). */
const MARGIN = 12;

/**
 * The bar fixed (or sticky) to the top or the bottom of the window outside the studio, if there is one.
 *
 * @param {HTMLElement} root The studio.
 * @param {boolean} [top] The top bar instead of the bottom one.
 * @returns {HTMLElement|null}
 */
const findBar = (root, top = false) => {
    if (typeof document.elementFromPoint !== 'function') {
        return null;
    }
    let element = document.elementFromPoint(window.innerWidth / 2, top ? 2 : window.innerHeight - 2);
    while (element && element !== document.body && element !== document.documentElement) {
        if (root && root.contains(element)) {
            return null;
        }
        const position = window.getComputedStyle(element).position;
        if (position === 'fixed' || position === 'sticky') {
            const box = element.getBoundingClientRect();
            // A bar along the edge, not a full-window layer.
            const atedge = top ? box.top <= 4 : box.bottom >= window.innerHeight - 4;
            return atedge && box.height < window.innerHeight / 3 ? element : null;
        }
        element = element.parentElement;
    }
    return null;
};

/**
 * The top of the bottom bar in the window (px), or the window's height when there is none.
 *
 * @param {HTMLElement} root The studio.
 * @returns {number}
 */
export const barTop = (root) => {
    const bar = findBar(root);
    return bar ? bar.getBoundingClientRect().top : window.innerHeight;
};

/**
 * The bottom of the top bar in the window (px), or 0 when there is none.
 *
 * @param {HTMLElement} root The studio.
 * @returns {number}
 */
export const topBarBottom = (root) => {
    const bar = findBar(root, true);
    return bar ? Math.max(0, bar.getBoundingClientRect().bottom) : 0;
};

/**
 * Scroll the page so an element is between the bars: its bottom above the bottom bar, without its top going under
 * the top bar (the top wins for an element taller than the space).
 *
 * @param {HTMLElement} root The studio.
 * @param {HTMLElement} element The element.
 */
export const reveal = (root, element) => {
    if (!element || typeof element.getBoundingClientRect !== 'function' || document.fullscreenElement) {
        return;
    }
    const box = element.getBoundingClientRect();
    if (!box.height) {
        return;
    }
    const roof = topBarBottom(root) + MARGIN;
    const floor = barTop(root) - MARGIN;
    let by = 0;
    if (box.top < roof) {
        by = box.top - roof;
    } else if (box.bottom > floor) {
        by = Math.min(box.bottom - floor, box.top - roof);
    }
    if (Math.abs(by) >= 1) {
        window.scrollBy(0, by);
    }
};

/**
 * Scroll the page so an element starts just below the top bar.
 *
 * @param {HTMLElement} root The studio.
 * @param {HTMLElement} element The element.
 */
export const startBelowTopBar = (root, element) => {
    if (!element || typeof element.getBoundingClientRect !== 'function') {
        return;
    }
    const by = element.getBoundingClientRect().top - topBarBottom(root) - MARGIN;
    if (Math.abs(by) >= 1) {
        window.scrollBy(0, by);
    }
};

/**
 * Watch the studio: keep the bar's height on it, and scroll focused controls and opened menus above the bar.
 *
 * @param {HTMLElement} root The studio.
 * @returns {Function} Stops watching.
 */
export const watch = (root) => {
    if (!root) {
        return () => null;
    }
    let height = -1;
    const measure = () => {
        const now = Math.max(0, Math.round(window.innerHeight - barTop(root)));
        if (now !== height) {
            height = now;
            root.style.setProperty('--mod-vrmakerspace-bottombar', `${height}px`);
        }
    };
    const onFocus = (event) => {
        const target = event.target;
        // Keyboard focus only: scrolling under a mouse press moves the control between press and release, and the
        // click is lost. The 3D view takes the focus too: it is not moved, or the tools above it would go under the
        // top bar.
        if (!target || target.tagName === 'CANVAS' || typeof target.matches !== 'function') {
            return;
        }
        let keyboard = false;
        try {
            keyboard = target.matches(':focus-visible');
        } catch (e) {
            keyboard = false;
        }
        if (keyboard) {
            reveal(root, target);
        }
    };
    const onShown = (event) => {
        const toggle = event.target;
        const menu = toggle && toggle.parentElement ? toggle.parentElement.querySelector('.dropdown-menu') : null;
        reveal(root, menu || toggle);
    };
    measure();
    // The bar is drawn after the page loads, and comes and goes with the window's size.
    const timer = window.setInterval(measure, 1000);
    window.addEventListener('resize', measure);
    root.addEventListener('focusin', onFocus);
    root.addEventListener('shown.bs.dropdown', onShown);
    return () => {
        window.clearInterval(timer);
        window.removeEventListener('resize', measure);
        root.removeEventListener('focusin', onFocus);
        root.removeEventListener('shown.bs.dropdown', onShown);
    };
};
