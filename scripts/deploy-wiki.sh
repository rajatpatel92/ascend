#!/bin/bash

# Configuration
WIKI_URL="https://github.com/rajatpatel92/ascend.wiki.git"
SOURCE_DIR="docs/wiki"
TEMP_DIR="tmp_wiki_deploy"

# Ensure we are in the project root
cd "$(dirname "$0")/.." || exit

echo "🚀 Starting Wiki Deployment..."

# 1. check if Source Docs exist
if [ ! -d "$SOURCE_DIR" ]; then
    echo "❌ Error: Source directory $SOURCE_DIR not found!"
    exit 1
fi

# 2. Cleanup previous temp dir
rm -rf "$TEMP_DIR"

# 3. Clone the Wiki Repo
echo "📥 Cloning GitHub Wiki..."
if git clone "$WIKI_URL" "$TEMP_DIR"; then
    echo "✅ Clone successful."
else
    echo "❌ Error: Could not clone wiki. Please ensure:"
    echo "   1. You have initialized the Wiki in GitHub Settings."
    echo "   2. You have created the first page (Home) via the Web UI."
    echo "   3. Your git credentials are set up."
    exit 1
fi

# 4. Copy files (Overwriting)
echo "📂 Copying documentation..."
cp -R "$SOURCE_DIR/"* "$TEMP_DIR/"

# 5. Commit and Push
cd "$TEMP_DIR" || exit

# Configure git if needed (using local settings)
if [ -z "$(git config user.name)" ]; then
    echo "⚠️  Git user not configured. Using 'Portfolio Bot'."
    git config user.name "Portfolio Bot"
    git config user.email "bot@portfolio.app"
fi

echo "Staging files..."
git add .

if git diff-index --quiet HEAD --; then
    echo "No changes to commit."
else
    echo "💾 Committing changes..."
    git commit -m "Update Wiki Documentation: $(date +'%Y-%m-%d')"
    
    echo "⬆️  Pushing to GitHub..."
    git push origin master
    echo "✅ Wiki successfully confirmed and pushed!"
fi

# 6. Cleanup
cd ..
rm -rf "$TEMP_DIR"
echo "🎉 Deployment Complete!"
