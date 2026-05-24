(function(){
  var STORAGE_THEME='cw-theme-v3';
  var toggle=document.getElementById('themeToggle');
  var icon=document.getElementById('themeIcon');

  function applyUniversalLogo(theme){
    document.querySelectorAll('.logo-universal').forEach(function(logo){
      var light=logo.getAttribute('data-logo-light');
      var dark=logo.getAttribute('data-logo-dark');
      if(!light && !dark){
        return;
      }
      var target=theme==='dark'?(dark||light):(light||dark);
      if(target && logo.getAttribute('src')!==target){
        logo.setAttribute('src',target);
      }
    });
  }

  function setTheme(t){
    document.documentElement.setAttribute('data-theme',t);
    try { localStorage.setItem(STORAGE_THEME,t); } catch(e) {}
    if(icon){
      icon.textContent=t==='dark'?'\u2600':'\u263E';
    }
    applyUniversalLogo(t);
  }

  var saved;
  try { saved=localStorage.getItem(STORAGE_THEME); } catch(e) {}
  if(saved==='dark')setTheme('dark');else setTheme('light');

  if(toggle){
    toggle.addEventListener('click',function(){
      var cur=document.documentElement.getAttribute('data-theme');
      var next=cur==='dark'?'light':'dark';
      setTheme(next);
      document.body.classList.remove('theme-flash');
      void document.body.offsetHeight;
      document.body.classList.add('theme-flash');
    });
  }
})();
