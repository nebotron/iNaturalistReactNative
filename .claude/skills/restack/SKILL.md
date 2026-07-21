---
name: restack
description: Clean up the commit history
---

Take all of the commits on main not on iNaturalist/main and arrange them more logically. For instance, the following should each be their own commit:
- Allow building the app using my Apple developer account
- Add support for cropping images
- Add AI-based subject detection
- Saved Explore filters
- Add Claude skills
- Wildlife Hotspots feature
- IDing game
- Filter my multiple taxa in explore
- In Add an ID, allow selecting the genus
- Bulk ID button for Unknown observations
- Make images in Explore view full width
- Allow agreeing, marking reviewed, and favoriting directly from explore view
- Use nearest neighbor interpolation when rendering images
- etc

The resulting set of commits should not contain reverts, or fixes for bugs in earlier commits. Each commit should be free-standing and correct. Each commit should contain only changes directly related to its title. The final set of changes should be identical to the initial set, just arranged more logically.

Present the final set of commits as a numbered list so the user can ask to combine or split them.
