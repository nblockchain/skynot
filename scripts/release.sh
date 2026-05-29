#!/usr/bin/env bash
set -euo pipefail

# Make sure we are on master branch and up to date
CURRENT_BRANCH=$(git branch --show-current)
if [ "$CURRENT_BRANCH" != "master" ]; then
    echo "ERROR: You must be on the 'master' branch to release (current: '$CURRENT_BRANCH')." >&2
    exit 1
fi

if [ -n "$(git status --porcelain)" ]; then
    echo "ERROR: Working directory is not clean. Commit or stash your changes first." >&2
    exit 1
fi

# Dry-run generation of the release notes for the next version
echo "Generating preview of conventional changelog for next release..."

# Get version from package.json
PKG_VERSION=$(node -p "require('./package.json').version")
NEXT_TAG="v$PKG_VERSION"

if git rev-parse "$NEXT_TAG" >/dev/null 2>&1; then
    echo "ERROR: Tag $NEXT_TAG already exists in git! Did you forget to bump version in package.json?" >&2
    exit 1
fi

# Generate releasing changelog
TEMP_CHANGELOG=$(mktemp)
# Since conventional-changelog automatically resolves the previous tag and generates the release notes
# from that last tag up to HEAD under the name/version declared in package.json, we don't need any
# temporary tagging or complex parsing hacks. It just works natively!
NODE_OPTIONS="--import tsx" npx --no-install conventional-changelog --config changelog.config.ts --release-count 1 > "$TEMP_CHANGELOG"

echo "--------------------------------------------------"
cat "$TEMP_CHANGELOG"
echo "--------------------------------------------------"

echo "Press any key to approve these release notes, write them to CHANGELOG.md, and commit/tag/push... (or Ctrl+C to abort)"
read -r -n 1 -s

# Create CHANGELOG.md if it doesn't exist
if [ ! -f CHANGELOG.md ]; then
    touch CHANGELOG.md
fi

# Prepend the new release notes to CHANGELOG.md
TEMP_FILE=$(mktemp)
cat "$TEMP_CHANGELOG" CHANGELOG.md > "$TEMP_FILE"
mv "$TEMP_FILE" CHANGELOG.md

# Clean up temp changelog file
rm "$TEMP_CHANGELOG"

# Format CHANGELOG.md if needed
if [ -f node_modules/.bin/prettier ] || [ -f package.json ]; then
    npm run format || true
fi

# Commit CHANGELOG.md and package.json version bump
git add CHANGELOG.md package.json
git commit -m "chore: release $NEXT_TAG"

# Tag the release commit
git tag "$NEXT_TAG"

# Push to origin
echo "Pushing commits and tags to origin..."
git push origin master
git push origin "$NEXT_TAG"

echo "Success! Release $NEXT_TAG pushed successfully."
