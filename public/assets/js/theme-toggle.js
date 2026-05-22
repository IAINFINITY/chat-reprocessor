(function(){
  var STORAGE_THEME='cw-theme-v3';
  var toggle=document.getElementById('themeToggle');
  var icon=document.getElementById('themeIcon');

  function setTheme(t){
    document.documentElement.setAttribute('data-theme',t);
    localStorage.setItem(STORAGE_THEME,t);
    icon.textContent=t==='dark'?'\u2600':'\u263E';
  }

  var saved=localStorage.getItem(STORAGE_THEME);
  if(saved==='dark')setTheme('dark');else setTheme('light');

  toggle.addEventListener('click',function(){
    var cur=document.documentElement.getAttribute('data-theme');
    setTheme(cur==='dark'?'light':'dark');
  });
})();
