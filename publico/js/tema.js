/* Fecha: 2026-04-20
   Ruta: /opt/dnns-rmm-server/publico/js/tema.js
   Contenido: Toggle tema claro/oscuro. Default CLARO (estandar DNNS). */

(function() {
  const KEY = 'rmm_tema';
  const guardado = localStorage.getItem(KEY);
  // Default: claro. Solo aplicamos oscuro si el usuario lo eligio antes.
  if (guardado === 'oscuro') {
    document.documentElement.setAttribute('data-tema', 'oscuro');
  }

  document.addEventListener('DOMContentLoaded', () => {
    const menu = document.querySelector('nav.menu');
    if (!menu) return;
    const btn = document.createElement('button');
    btn.className = 'btn-tema';
    btn.title = 'Cambiar tema';
    btn.type = 'button';
    actualizarIcono(btn);
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const actual = document.documentElement.getAttribute('data-tema');
      if (actual === 'oscuro') {
        document.documentElement.removeAttribute('data-tema');
        localStorage.setItem(KEY, 'claro');
      } else {
        document.documentElement.setAttribute('data-tema', 'oscuro');
        localStorage.setItem(KEY, 'oscuro');
      }
      actualizarIcono(btn);
    });
    menu.appendChild(btn);
  });

  function actualizarIcono(btn) {
    const esOscuro = document.documentElement.getAttribute('data-tema') === 'oscuro';
    btn.textContent = esOscuro ? '☀' : '🌙';
  }
})();
