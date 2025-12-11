// document.addEventListener('DOMContentLoaded', function () {
//   const toggle = document.querySelector('.mobile-menu-toggle');
//   const closeBtn = document.querySelector('.sidebar-close');

//   function openSidebar() {
//     document.body.classList.add('sidebar-open');
//   }

//   function closeSidebar() {
//     document.body.classList.remove('sidebar-open');
//   }

//   if (toggle) {
//     toggle.addEventListener('click', function () {
//       document.body.classList.toggle('sidebar-open');
//     });
//   }

//   if (closeBtn) {
//     closeBtn.addEventListener('click', closeSidebar);
//   }
// });


document.addEventListener('DOMContentLoaded', function () {
  console.log('[sidebar.js] DOMContentLoaded fired');

  const toggle = document.querySelector('.mobile-menu-toggle');
  const closeBtn = document.querySelector('.sidebar-close');

  console.log('[sidebar.js] toggle element:', toggle);
  console.log('[sidebar.js] closeBtn element:', closeBtn);

  function openSidebar() {
    console.log('[sidebar.js] openSidebar() called');
    document.body.classList.add('sidebar-open');
    console.log('[sidebar.js] body.classList:', document.body.className);
  }

  function closeSidebar() {
    console.log('[sidebar.js] closeSidebar() called');
    document.body.classList.remove('sidebar-open');
    console.log('[sidebar.js] body.classList:', document.body.className);
  }

  if (toggle) {
    console.log('[sidebar.js] Attaching click handler to .mobile-menu-toggle');
    toggle.addEventListener('click', function () {
      console.log('[sidebar.js] Hamburger clicked');
      // You can use open/close if you prefer, but this matches your original logic:
      document.body.classList.toggle('sidebar-open');
      console.log('[sidebar.js] body.classList after toggle:', document.body.className);
    });
  } else {
    console.warn('[sidebar.js] .mobile-menu-toggle NOT found in DOM');
  }

  if (closeBtn) {
    console.log('[sidebar.js] Attaching click handler to .sidebar-close');
    closeBtn.addEventListener('click', function () {
      console.log('[sidebar.js] Close button clicked');
      closeSidebar();
    });
  } else {
    console.warn('[sidebar.js] .sidebar-close NOT found in DOM');
  }
});
