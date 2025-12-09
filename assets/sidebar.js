document.addEventListener('DOMContentLoaded', function () {
  const toggle = document.querySelector('.mobile-menu-toggle');
  const closeBtn = document.querySelector('.sidebar-close');

  function openSidebar() {
    document.body.classList.add('sidebar-open');
  }

  function closeSidebar() {
    document.body.classList.remove('sidebar-open');
  }

  if (toggle) {
    toggle.addEventListener('click', function () {
      document.body.classList.toggle('sidebar-open');
    });
  }

  if (closeBtn) {
    closeBtn.addEventListener('click', closeSidebar);
  }
});
