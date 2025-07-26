# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

YOUChat_Proxy is a Node.js proxy server that converts you.com subscriptions into a universal API. The project supports multiple AI providers including You.com, Perplexity, and HappyAPI, with automatic browser session management and cookie handling.

## Key Commands

### Development
- `node index.mjs` - Start the proxy server
- `make all` - Run with sudo (from Makefile)
- `./start.sh` - Run with environment configuration
- `npm install` - Install dependencies

### Configuration
- Copy `config.example.mjs` to `config.mjs` and configure sessions
- Environment variables are set in `start.sh` for configuration
- The app automatically copies `config.mjs` to `xconfig.mjs` at runtime

## Architecture

### Core Components
- **index.mjs** - Main Express server entry point with API endpoints
- **provider.mjs** - ProviderManager that handles multiple AI providers (You, Perplexity, HappyAPI)
- **sessionManager.mjs** - Manages browser sessions and cookie handling
- **proxyAgent.mjs** - HTTP/SOCKS proxy configuration

### Provider Structure
Each provider is in its own directory:
- **you_providers/** - You.com integration with cookie management and text processing
- **perplexity_providers/** - Perplexity AI integration
- **happyapi_providers/** - HappyAPI integration

### Utilities
- **utils/** - Browser detection, fingerprinting, and cookie utilities
- **imageStorage.mjs** - Handles image upload and storage
- **networkMonitor.mjs** - Network monitoring functionality
- **requestLogger.mjs** - Request logging with Winston

## Key Environment Variables

Set via `start.sh`:
- `ACTIVE_PROVIDER` - Choose provider: you/perplexity/happyapi
- `BROWSER_TYPE` - Browser choice: chrome/edge/auto
- `USE_MANUAL_LOGIN` - Enable manual login mode
- `PORT` - Server port (default 8080)
- `PASSWORD` - API authentication password
- `AI_MODEL` - Specific AI model to use

## Configuration Files

- **config.mjs** - Main configuration with session cookies (created from config.example.mjs)
- **perplexityConfig.mjs** - Perplexity-specific configuration
- The app uses dynamic imports and copies configs to xconfig.mjs at runtime

## Docker Support

- Uses Dockerfile and docker-entrypoint.sh for containerized deployment
- **docker-start.sh** - Docker-optimized startup script with persistent browser settings
- Supports Zeabur deployment via zeabur.yaml
- Handles config file copying in Docker environment (/app/config.mjs → /app/xconfig.mjs)

### Docker Performance Optimizations

Recent fixes for browser session persistence in Docker:
- **Browser Instance Recovery**: Automatic reconnection when browser connections drop
- **Session Timeout Management**: Configurable timeout (0=disabled) to prevent frequent restarts
- **Browser Instance Recycling**: 10-minute cleanup cycle for unused instances
- **Page Recovery Logic**: Automatic page recreation when browser pages close
- **Optimized Browser Args**: Docker-specific Chrome/Edge launch parameters

**Docker Environment Variables**:
- `SESSION_LOCK_TIMEOUT=0` - Disable session timeout to prevent browser restarts
- `BROWSER_INSTANCE_COUNT=1` - Use single instance for stability
- `HEADLESS_BROWSER=true` - Recommended for Docker
- `ENABLE_DELAY_LOGIC=true` - Prevent request throttling