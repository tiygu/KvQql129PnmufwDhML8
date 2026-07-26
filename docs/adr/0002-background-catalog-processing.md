# Keep catalog enrichment off the automation critical path

Catalog inference and image processing will run on demand at safe boundaries, use bounded background work and persistent caches, and never become an operator-facing performance feature. The first implementation should apply straightforward optimizations and establish lightweight development measurements, while performance improvements remain iterative responses to observed regressions rather than fixed numerical release gates.
