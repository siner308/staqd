# Release staqd

Release a new version of staqd. This is a GitHub Action, so floating major/minor tags must be updated for users referencing `siner308/staqd@v1` or `siner308/staqd@v1.2`.

## Steps

1. Determine the new version by checking the latest release:
   ```bash
   gh release list --limit 3
   ```
   Bump patch for fixes, minor for features, major for breaking changes.

2. Create the GitHub release (this also creates the git tag):
   ```bash
   gh release create v<X.Y.Z> --target main --title "v<X.Y.Z>" --notes "<release notes>"
   ```

3. **CRITICAL — Update floating tags.** Fetch the new tag, then force-update major and minor tags:
   ```bash
   git fetch --tags
   git tag -f v<X> v<X.Y.Z>
   git tag -f v<X.Y> v<X.Y.Z>
   git push origin v<X> v<X.Y> --force
   ```
   For example, releasing v1.2.3 requires updating both `v1` and `v1.2`.

4. Verify all three tags point to the same commit:
   ```bash
   git rev-parse v<X.Y.Z> v<X.Y> v<X>
   ```

Without step 3, users pinning `@v1` will be stuck on the old version.
