# Rebuilds site/index.html, site/pricing/, site/docs/ and site/support/ from these files.
import os, runpy
here = os.path.dirname(os.path.abspath(__file__))
for page in ['home', 'pricing', 'docs', 'support']:
    runpy.run_path(os.path.join(here, page + '.py'))
