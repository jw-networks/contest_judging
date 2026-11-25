# Shared header and footer for the website pages.
# Edit a page's .py file here, then run:  python3 tools/site/build.py
def head(title, desc, path, extra_head=''):
    return f'''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<meta name="description" content="{desc}">
<meta name="theme-color" content="#1b1a1b">
<link rel="icon" href="/app/icons/icon.svg" type="image/svg+xml">
<link rel="preload" href="/app/fonts/Roboto-Variable.ttf" as="font" type="font/ttf" crossorigin>
<link rel="stylesheet" href="/site.css">
<meta property="og:title" content="{title}">
<meta property="og:description" content="{desc}">
<meta property="og:image" content="https://spotlight.drimworksprops.com/img/og.png">
<meta property="og:type" content="website">
<meta name="twitter:card" content="summary_large_image">
{extra_head}</head>
<body>
<a class="hp" href="#main">Skip to content</a>
<header class="top">
  <div class="wrap">
    <a class="brand" href="/"><img src="/app/icons/icon.svg" alt="" width="30" height="30">Spotlight</a>
    <nav class="nav" id="nav" aria-label="Main">
      <a href="/#how"{' aria-current="page"' if path == 'how' else ''}>How it works</a>
      <a href="/pricing/"{' aria-current="page"' if path == 'pricing' else ''}>Pricing</a>
      <a href="/docs/"{' aria-current="page"' if path == 'docs' else ''}>Docs</a>
      <a href="/support/"{' aria-current="page"' if path == 'support' else ''}>Support</a>
    </nav>
    <div class="top-actions">
      <a class="signin" href="/app/">Sign in</a>
      <a class="btn primary small" href="/pricing/#request">Get started</a>
    </div>
    <button class="menu-btn" aria-controls="nav" aria-expanded="false" aria-label="Menu"><svg width="20" height="14" viewBox="0 0 20 14" aria-hidden="true"><path d="M0 1h20M0 7h20M0 13h20" stroke="currentColor" stroke-width="2"/></svg></button>
  </div>
</header>
<main id="main">
'''

def foot():
    return '''</main>
<footer class="foot">
  <div class="wrap">
    <div><a class="brand" href="/" style="padding:0;margin-bottom:12px"><img src="/app/icons/icon.svg" alt="" width="26" height="26">Spotlight</a>
      <p style="margin:0">Contest judging for cosplay and maker shows.<br>Made by Drimworks Props.</p></div>
    <div><b>Product</b><a href="/#how">How it works</a><a href="/pricing/">Pricing</a><a href="/app/">Sign in</a></div>
    <div><b>Help</b><a href="/docs/">Docs</a><a href="/support/">Support</a><a href="/docs/#offline">Running without internet</a></div>
    <div><b>Get started</b><a href="/pricing/#request">Request Spotlight</a><a href="/support/#contact">Contact us</a></div>
  </div>
</footer>
<script src="/app/config.js"></script>
<script src="/site.js" defer></script>
</body>
</html>
'''
