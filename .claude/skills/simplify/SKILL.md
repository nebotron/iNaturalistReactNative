---
name: simplify
description: Remove unnecessary changes
---

Look at the diff between the current branch and iNaturalist/main. Make a numbered list of changes in that diff which are unnecessary, outdated, or can be simplified.

Do not flag personal local-dev configuration as unnecessary — e.g. personal Apple `DEVELOPMENT_TEAM`/`PRODUCT_BUNDLE_IDENTIFIER` in `project.pbxproj`, personal entitlements/associated-domains, or the app display name. These are intentionally kept even though they'll never be upstreamed.
