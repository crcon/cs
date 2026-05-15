#!/bin/bash

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
RED='\033[0;31m'
NC='\033[0m' # No Color

echo -e "${BLUE}🚀 开始部署到 GitHub Pages...${NC}"

# 检查是否有未提交的更改
if [ -z "$(git status --porcelain)" ]; then
    echo -e "${GREEN}✓ 工作区干净${NC}"
else
    echo -e "${RED}✗ 有未提交的更改，请先提交${NC}"
    exit 1
fi

# 检查 dist 目录是否存在
if [ ! -d "dist" ]; then
    echo -e "${RED}✗ dist 目录不存在，请先运行 npm run build${NC}"
    exit 1
fi

echo -e "${BLUE}📦 准备部署文件...${NC}"

# 创建临时目录用于存储部署文件
TEMP_DIR=$(mktemp -d)
trap "rm -rf $TEMP_DIR" EXIT

# 复制 dist 目录到临时目录
cp -r dist/* "$TEMP_DIR/"

# 检查是否存在 gh-pages 分支
if git rev-parse --verify gh-pages > /dev/null 2>&1; then
    echo -e "${GREEN}✓ gh-pages 分支已存在${NC}"
    git checkout gh-pages
else
    echo -e "${BLUE}🌿 创建 gh-pages 分支...${NC}"
    git checkout --orphan gh-pages
    git rm -rf .
fi

# 清空 gh-pages 分支的内容
git rm -rf . 2>/dev/null || true

# 复制新的文件
cp -r "$TEMP_DIR"/* .
if [ -f "$TEMP_DIR/.nojekyll" ]; then
    cp "$TEMP_DIR/.nojekyll" .
fi

# 添加所有文件
git add -A

# 如果有更改才提交
if [ -n "$(git status --porcelain)" ]; then
    git commit -m "Deploy to GitHub Pages $(date '+%Y-%m-%d %H:%M:%S')"
    
    echo -e "${BLUE}📤 推送到 GitHub...${NC}"
    git push -u origin gh-pages -f
    echo -e "${GREEN}✓ 推送完成${NC}"
else
    echo -e "${BLUE}ℹ️  没有新的更改需要提交${NC}"
fi

# 回到 main 分支
git checkout main

echo -e "${GREEN}✅ 部署完成！${NC}"
echo -e "${BLUE}你的网站将在以下地址访问：${NC}"
echo -e "${GREEN}https://crcon.github.io/cs${NC}"
