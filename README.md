# voyager-poller

The polling half of **Voyager**: a GitHub Actions job that checks company career boards
(Workday, Greenhouse, Lever, Ashby, Oracle, SuccessFactors, Workable, Rippling, BambooHR)
for newly posted co-ops and internships and reports *changes only* to the Voyager app.

- Polite by design: identifies as `VoyagerBot`, honors robots.txt (including Crawl-delay
  and per-site disallows), limits concurrency per host, and backs off on 429/5xx.
- Uses only public job-board endpoints. Never touches university job portals.
- Not affiliated with Northeastern University or any employer.

Crawler questions or opt-out: open an issue on this repository.
