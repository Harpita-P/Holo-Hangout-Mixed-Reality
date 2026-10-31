const isWorld = /^\/world\/[^/]+\/?$/u.test(window.location.pathname);
document.body.dataset.mode = isWorld ? 'world' : 'site';

if (isWorld) {
  void import('./index.js');
} else {
  void import('./site.js').then(({ renderSite }) => renderSite());
}
