---
name: tune
description: Improve performance of the CV-based subject detector.
---

There is a script scripts/evaluate_subject_detector.py for evaluating crop quality. Report the current evaluation of the subject detection algorithm on the entire set of labeled images, which is >300 images. Try to improve it, and report the new score. Explore all available options, including different models, different heuristics, or retraining the model. If the new score is better, apply the subject detection changes to the React Native app. Commit your entire model into git
