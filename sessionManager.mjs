import fs from 'fs';
import path from 'path';
import {Mutex} from 'async-mutex';
import {detectBrowser} from './utils/browserDetector.mjs';
import {createDirectoryIfNotExists} from './utils/cookieUtils.mjs';
import {fileURLToPath} from 'url';
import {optimizeBrowserDisplay} from './utils/browserDisplayFixer.mjs';
import {launchEdgeBrowser} from './utils/edgeLauncher.mjs';
import {setupBrowserFingerprint} from './utils/browserFingerprint.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const isHeadless = process.env.HEADLESS_BROWSER === 'true' && process.env.USE_MANUAL_LOGIN !== 'true';
let puppeteerModule;
let connect;
if (isHeadless === false) {
    puppeteerModule = await import('puppeteer-real-browser');
    connect = puppeteerModule.connect;
} else {
    puppeteerModule = await import('puppeteer-core');
}

// 会话自动释放时间（秒）
const SESSION_LOCK_TIMEOUT = parseInt(process.env.SESSION_LOCK_TIMEOUT || '0', 10);

// 存储已达请求上限的账号(格式: "timestamp | username")
const cooldownFilePath = path.join(__dirname, 'cooldownAccounts.log');

// 冷却时长(默认24小时)
const COOLDOWN_DURATION = 24 * 60 * 60 * 1000;

class SessionManager {
    constructor(provider) {
        this.provider = provider;
        this.isCustomModeEnabled = process.env.USE_CUSTOM_MODE === 'true';
        this.isRotationEnabled = process.env.ENABLE_MODE_ROTATION === 'true';
        this.isHeadless = isHeadless; // 是否隐藏浏览器
        this.currentIndex = 0;
        this.usernameList = []; // 缓存用户名列表
        this.browserInstances = []; // 浏览器实例数组
        this.browserMutex = new Mutex(); // 浏览器互斥锁
        this.browserIndex = 0;
        this.sessionAutoUnlockTimers = {}; // 自动解锁计时器
        this.cooldownList = this.loadCooldownList(); // 加载并清理 cooldown 文件
        this.cleanupCooldownList();
        this.isDockerEnvironment = process.env.DOCKER_ENV === 'true' || fs.existsSync('/.dockerenv');
        
        // Docker环境下启用浏览器实例回收机制
        if (this.isDockerEnvironment) {
            this.setupBrowserInstanceRecycling();
        }
    }

    setSessions(sessions) {
        this.sessions = sessions;
        this.usernameList = Object.keys(this.sessions);

        // 为每个 session 初始化相关属性
        for (const username in this.sessions) {
            const session = this.sessions[username];
            session.locked = false;           // 标记会话是否被锁定
            session.requestCount = 0;         // 请求计数
            session.valid = true;            // 标记会话是否有效
            session.mutex = new Mutex();      // 创建互斥锁
            if (session.currentMode === undefined) {
                session.currentMode = this.isCustomModeEnabled ? 'custom' : 'default';
            }
            if (!session.modeStatus) {
                session.modeStatus = {
                    default: true,
                    custom: true,
                };
            }
            session.rotationEnabled = true; // 是否启用模式轮换
            session.switchCounter = 0; // 模式切换计数器
            session.requestsInCurrentMode = 0; // 当前模式下的请求次数
            session.lastDefaultThreshold = 0; // 上次默认模式阈值
            session.switchThreshold = this.provider.getRandomSwitchThreshold(session);

            // 记录请求次数
            session.youTotalRequests = 0;
            // 权重
            if (typeof session.weight !== 'number') {
                session.weight = 1;
            }
        }
    }

    loadCooldownList() {
        try {
            if (!fs.existsSync(cooldownFilePath)) {
                fs.writeFileSync(cooldownFilePath, '', 'utf8');
                return [];
            }
            const lines = fs.readFileSync(cooldownFilePath, 'utf8')
                .split('\n')
                .map(line => line.trim())
                .filter(line => line.length > 0);

            const arr = [];
            for (const line of lines) {
                const parts = line.split('|').map(x => x.trim());
                if (parts.length === 2) {
                    const timestamp = parseInt(parts[0], 10);
                    const name = parts[1];
                    if (!isNaN(timestamp) && name) {
                        arr.push({time: timestamp, username: name});
                    }
                }
            }
            return arr;
        } catch (err) {
            console.error(`读取 ${cooldownFilePath} 出错:`, err);
            return [];
        }
    }

    saveCooldownList() {
        try {
            const lines = this.cooldownList.map(item => `${item.time} | ${item.username}`);
            fs.writeFileSync(cooldownFilePath, lines.join('\n') + '\n', 'utf8');
        } catch (err) {
            console.error(`写入 ${cooldownFilePath} 出错:`, err);
        }
    }

    // 清理过期(超过指定冷却时长)
    cleanupCooldownList() {
        const now = Date.now();
        let changed = false;
        this.cooldownList = this.cooldownList.filter(item => {
            const expired = (now - item.time) >= COOLDOWN_DURATION;
            if (expired) changed = true;
            return !expired;
        });
        if (changed) {
            this.saveCooldownList();
        }
    }

    recordLimitedAccount(username) {
        const now = Date.now();
        const already = this.cooldownList.find(x => x.username === username);
        if (!already) {
            this.cooldownList.push({time: now, username});
            this.saveCooldownList();
            console.log(`写入冷却列表：${new Date(now).toLocaleString()} | ${username}`);
        }
    }

    // 是否在冷却期(24小时内)
    isInCooldown(username) {
        this.cleanupCooldownList();
        return this.cooldownList.some(item => item.username === username);
    }

    // 批量初始化浏览器实例
    async initBrowserInstancesInBatch() {
        const browserCount = parseInt(process.env.BROWSER_INSTANCE_COUNT) || 1;
        // 可以是 'chrome', 'edge', 或 'auto'
        const browserPath = detectBrowser(process.env.BROWSER_TYPE || 'auto');
        const sharedProfilePath = path.join(__dirname, 'browser_profiles');
        createDirectoryIfNotExists(sharedProfilePath);

        const tasks = [];
        for (let i = 0; i < browserCount; i++) {
            const browserId = `browser_${i}`;
            const userDataDir = path.join(sharedProfilePath, browserId);
            createDirectoryIfNotExists(userDataDir);

            tasks.push(this.launchSingleBrowser(browserId, userDataDir, browserPath));
        }

        // 并行执行
        const results = await Promise.all(tasks);
        for (const instanceInfo of results) {
            this.browserInstances.push(instanceInfo);
            console.log(`创建浏览器实例: ${instanceInfo.id}`);
        }
    }

    async launchSingleBrowser(browserId, userDataDir, browserPath) {
        let browser, page;
        const isEdge = browserPath.toLowerCase().includes('msedge') ||
            process.env.BROWSER_TYPE === 'edge';
        if (isEdge) {
            try {
                const debugPort = 9222 + parseInt(browserId.replace('browser_', ''), 10);
                const result = await launchEdgeBrowser(userDataDir, browserPath, debugPort);
                browser = result.browser;
                page = result.page;

                console.log(`Edge浏览器启动成功 (browserId=${browserId})`);
            } catch (error) {
                console.error(`原生启动Edge失败:`, error);
                console.log(`回退标准方式启动浏览器...`);
            }
        }

        if (!browser) {
            if (isHeadless === false) {
                // 使用 puppeteer-real-browser
                const response = await connect({
                    headless: 'auto',
                    turnstile: true,
                    customConfig: {
                        userDataDir: userDataDir,
                        executablePath: browserPath,
                        args: [
                            '--no-sandbox',
                            '--disable-setuid-sandbox',
                            '--remote-debugging-address=::',
                            '--window-size=1280,850',
                            '--force-device-scale-factor=1',
                        ],
                    },
                });
                browser = response.browser;
                page = response.page;
            } else {
                // 使用 puppeteer-core
                browser = await puppeteerModule.launch({
                    headless: this.isHeadless,
                    executablePath: browserPath,
                    userDataDir: userDataDir,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-gpu',
                        '--disable-dev-shm-usage',
                        '--disable-web-security',
                        '--disable-features=VizDisplayCompositor',
                        '--disable-background-timer-throttling',
                        '--disable-backgrounding-occluded-windows',
                        '--disable-renderer-backgrounding',
                        '--disable-field-trial-config',
                        '--disable-background-networking',
                        '--no-first-run',
                        '--no-default-browser-check',
                        '--remote-debugging-port=0',
                        '--window-size=1280,850',
                        '--force-device-scale-factor=1',
                        '--memory-pressure-off',
                        '--max_old_space_size=4096',
                    ],
                });
                page = await browser.newPage();
            }
        }

        const originalUserAgent = await page.evaluate(() => navigator.userAgent);
        // console.log(`浏览器 ${browserId} 原始用户代理: ${originalUserAgent}`);

        const browserType = isEdge ? 'edge' : 'chrome';
        const fingerprint = await setupBrowserFingerprint(page, browserType);

        try {
            const newUserAgent = await page.evaluate(() => navigator.userAgent);
            const newPlatform = await page.evaluate(() => navigator.platform);
            const newCores = await page.evaluate(() => navigator.hardwareConcurrency);

            // console.log(`浏览器 ${browserId} 应用指纹后:`);
            // console.log(`- 用户代理: ${newUserAgent}`);
            // console.log(`- 平台: ${newPlatform}`);
            // console.log(`- CPU核心: ${newCores}`);
            // console.log(`- 内存: ${fingerprint.ram}GB`);
            // console.log(`- 设备名称: ${fingerprint.deviceName}`);

            const isActuallyEdge = newUserAgent.includes('Edg');

            // 应用显示优化
            try {
                await optimizeBrowserDisplay(page, {
                    width: 1280,
                    height: 850,
                    deviceScaleFactor: 1,
                    cssScale: 1,
                    fixHighDpi: true,
                    isHeadless: this.isHeadless
                });
            } catch (error) {
                console.warn(`显示优化失败:`, error);
            }

            return {
                id: browserId,
                browser: browser,
                page: page,
                locked: false,
                isEdgeBrowser: isActuallyEdge,
                fingerprint: fingerprint  // 存储指纹信息
            };
        } catch (error) {
            console.error(`验证指纹时出错:`, error);

            try {
                await optimizeBrowserDisplay(page, {
                    width: 1280,
                    height: 850,
                    deviceScaleFactor: 1,
                    cssScale: 1,
                    fixHighDpi: true,
                    isHeadless: this.isHeadless
                });
            } catch (displayError) {
                console.warn(`显示优化失败:`, displayError);
            }

            const isActuallyEdge = originalUserAgent.includes('Edg');
            return {
                id: browserId,
                browser: browser,
                page: page,
                locked: false,
                isEdgeBrowser: isActuallyEdge
            };
        }
    }

    async getAvailableBrowser() {
        return await this.browserMutex.runExclusive(async () => {
            const totalBrowsers = this.browserInstances.length;

            for (let i = 0; i < totalBrowsers; i++) {
                const index = (this.browserIndex + i) % totalBrowsers;
                const browserInstance = this.browserInstances[index];

                // 检查浏览器连接状态，如果断开则尝试重新连接
                if (!browserInstance.locked) {
                    try {
                        // 检查浏览器是否仍然连接
                        if (browserInstance.browser.isConnected && browserInstance.browser.isConnected()) {
                            // 检查页面是否仍然可用
                            if (!browserInstance.page.isClosed()) {
                                browserInstance.locked = true;
                                this.browserIndex = (index + 1) % totalBrowsers;
                                return browserInstance;
                            }
                        }
                        
                        // 浏览器断开连接，尝试重新创建页面
                        console.warn(`浏览器实例 ${browserInstance.id} 连接已断开，尝试恢复...`);
                        await this.recoverBrowserInstance(browserInstance);
                        
                        browserInstance.locked = true;
                        this.browserIndex = (index + 1) % totalBrowsers;
                        return browserInstance;
                    } catch (error) {
                        console.error(`检查浏览器实例 ${browserInstance.id} 状态失败:`, error);
                        // 如果检查失败，尝试重新创建
                        await this.recoverBrowserInstance(browserInstance);
                        browserInstance.locked = true;
                        this.browserIndex = (index + 1) % totalBrowsers;
                        return browserInstance;
                    }
                }
            }
            throw new Error('当前负载已饱和，请稍后再试(以达到最大并发)');
        });
    }

    async releaseBrowser(browserId) {
        await this.browserMutex.runExclusive(async () => {
            const browserInstance = this.browserInstances.find(b => b.id === browserId);
            if (browserInstance) {
                // 清理页面状态但保持浏览器实例运行
                try {
                    if (!browserInstance.page.isClosed()) {
                        // 清理页面状态，但不关闭页面
                        await browserInstance.page.evaluate(() => {
                            // 清理本地存储和会话存储
                            if (typeof localStorage !== 'undefined') {
                                localStorage.clear();
                            }
                            if (typeof sessionStorage !== 'undefined') {
                                sessionStorage.clear();
                            }
                        });
                    }
                } catch (error) {
                    console.warn(`清理浏览器实例 ${browserId} 状态时出错:`, error);
                }
                browserInstance.locked = false;
            }
        });
    }

    async getAvailableSessions() {
        const allSessionsLocked = this.usernameList.every(username => this.sessions[username].locked);
        if (allSessionsLocked) {
            throw new Error('所有会话处于饱和状态，请稍后再试(无可用账号)');
        }

        // 收集所有valid && !locked && (不在冷却期)
        let candidates = [];
        for (const username of this.usernameList) {
            const session = this.sessions[username];
            // 如果没被锁 并且 session.valid
            if (session.valid && !session.locked) {
                if (this.provider.enableRequestLimit && this.isInCooldown(username)) {
                    // console.log(`账号 ${username} 处于 24 小时冷却中，跳过`);
                    continue;
                }
                candidates.push(username);
            }
        }

        if (candidates.length === 0) {
            throw new Error('没有可用的会话');
        }

        // 随机洗牌
        shuffleArray(candidates);

        // 加权抽签
        let weightSum = 0;
        for (const uname of candidates) {
            weightSum += this.sessions[uname].weight;
        }

        // 生成随机
        const randValue = Math.floor(Math.random() * weightSum) + 1;

        // 遍历并扣减
        let cumulative = 0;
        let selectedUsername = null;
        for (const uname of candidates) {
            cumulative += this.sessions[uname].weight;
            if (randValue <= cumulative) {
                selectedUsername = uname;
                break;
            }
        }

        if (!selectedUsername) {
            selectedUsername = candidates[0];
        }

        const selectedSession = this.sessions[selectedUsername];

        // 再尝试锁定账号
        const result = await selectedSession.mutex.runExclusive(async () => {
            if (selectedSession.locked) {
                return null;
            }

            // 判断是否可用
            if (selectedSession.modeStatus && selectedSession.modeStatus[selectedSession.currentMode]) {
                // 锁定
                selectedSession.locked = true;
                selectedSession.requestCount++;

                // 获取可用浏览器
                const browserInstance = await this.getAvailableBrowser();

                // 启动自动解锁计时器
                if (SESSION_LOCK_TIMEOUT > 0) {
                    this.startAutoUnlockTimer(selectedUsername, browserInstance.id);
                }

                return {
                    selectedUsername,
                    modeSwitched: false,
                    browserInstance
                };
            } else if (
                this.isCustomModeEnabled &&
                this.isRotationEnabled &&
                this.provider &&
                typeof this.provider.switchMode === 'function'
            ) {
                console.warn(`尝试为账号 ${selectedUsername} 切换模式...`);
                this.provider.switchMode(selectedSession);
                selectedSession.rotationEnabled = false;

                if (selectedSession.modeStatus && selectedSession.modeStatus[selectedSession.currentMode]) {
                    selectedSession.locked = true;
                    selectedSession.requestCount++;
                    const browserInstance = await this.getAvailableBrowser();

                    if (SESSION_LOCK_TIMEOUT > 0) {
                        this.startAutoUnlockTimer(selectedUsername, browserInstance.id);
                    }

                    return {
                        selectedUsername,
                        modeSwitched: true,
                        browserInstance
                    };
                }
            }

            return null;
        });

        if (result) {
            return result;
        } else {
            throw new Error('会话刚被占用或模式不可用!');
        }
    }

    startAutoUnlockTimer(username, browserId) {
        // 清除可能残留计时器
        if (this.sessionAutoUnlockTimers[username]) {
            clearTimeout(this.sessionAutoUnlockTimers[username]);
        }
        
        // 如果超时时间为0，不启动计时器（永不超时）
        if (SESSION_LOCK_TIMEOUT === 0) {
            return;
        }
        
        const lockDurationMs = SESSION_LOCK_TIMEOUT * 1000;

        this.sessionAutoUnlockTimers[username] = setTimeout(async () => {
            const session = this.sessions[username];
            if (session && session.locked) {
                console.warn(
                    `会话 "${username}" 已自动解锁（超时${SESSION_LOCK_TIMEOUT}秒）`
                );

                await session.mutex.runExclusive(async () => {
                    session.locked = false;
                });

                // 释放关联的浏览器，但不关闭浏览器实例
                if (browserId) {
                    await this.releaseBrowser(browserId);
                }
            }
        }, lockDurationMs);
    }

    async recoverBrowserInstance(browserInstance) {
        try {
            console.log(`开始恢复浏览器实例 ${browserInstance.id}...`);
            
            // 如果浏览器进程仍然存在但页面关闭，创建新页面
            if (browserInstance.browser && browserInstance.browser.isConnected && browserInstance.browser.isConnected()) {
                if (browserInstance.page.isClosed()) {
                    console.log(`为浏览器实例 ${browserInstance.id} 创建新页面...`);
                    browserInstance.page = await browserInstance.browser.newPage();
                    
                    // 重新应用指纹和显示优化
                    if (browserInstance.fingerprint) {
                        const browserType = browserInstance.isEdgeBrowser ? 'edge' : 'chrome';
                        await setupBrowserFingerprint(browserInstance.page, browserType);
                    }
                    
                    await optimizeBrowserDisplay(browserInstance.page, {
                        width: 1280,
                        height: 850,
                        deviceScaleFactor: 1,
                        cssScale: 1,
                        fixHighDpi: true,
                        isHeadless: this.isHeadless
                    });
                }
            } else {
                // 浏览器进程已断开，需要完全重新启动
                console.log(`浏览器实例 ${browserInstance.id} 进程已断开，重新启动...`);
                
                const browserPath = detectBrowser(process.env.BROWSER_TYPE || 'auto');
                const sharedProfilePath = path.join(__dirname, 'browser_profiles');
                const userDataDir = path.join(sharedProfilePath, browserInstance.id);
                
                // 重新启动浏览器
                const newInstance = await this.launchSingleBrowser(browserInstance.id, userDataDir, browserPath);
                
                // 更新现有实例的引用
                browserInstance.browser = newInstance.browser;
                browserInstance.page = newInstance.page;
                browserInstance.fingerprint = newInstance.fingerprint;
                browserInstance.isEdgeBrowser = newInstance.isEdgeBrowser;
            }
            
            console.log(`浏览器实例 ${browserInstance.id} 恢复成功`);
        } catch (error) {
            console.error(`恢复浏览器实例 ${browserInstance.id} 失败:`, error);
            throw error;
        }
    }

    setupBrowserInstanceRecycling() {
        console.log('Docker环境检测到，启用浏览器实例回收机制');
        
        // 每10分钟检查一次浏览器实例状态
        setInterval(async () => {
            await this.recycleBrowserInstances();
        }, 10 * 60 * 1000);
    }

    async recycleBrowserInstances() {
        console.log('开始回收浏览器实例...');
        
        for (const browserInstance of this.browserInstances) {
            if (!browserInstance.locked) {
                try {
                    // 检查浏览器是否还在运行
                    if (browserInstance.browser && browserInstance.browser.isConnected && browserInstance.browser.isConnected()) {
                        // 浏览器还在运行，检查页面状态
                        if (browserInstance.page && !browserInstance.page.isClosed()) {
                            // 清理页面缓存和状态但保持页面打开
                            await browserInstance.page.evaluate(() => {
                                if (typeof localStorage !== 'undefined') {
                                    localStorage.clear();
                                }
                                if (typeof sessionStorage !== 'undefined') {
                                    sessionStorage.clear();
                                }
                            });
                        }
                    }
                } catch (error) {
                    console.warn(`回收浏览器实例 ${browserInstance.id} 时出错:`, error);
                }
            }
        }
        
        console.log('浏览器实例回收完成');
    }

    async releaseSession(username, browserId) {
        const session = this.sessions[username];
        if (session) {
            await session.mutex.runExclusive(() => {
                session.locked = false;
            });
        }
        // 存在相应计时器清除
        if (this.sessionAutoUnlockTimers[username]) {
            clearTimeout(this.sessionAutoUnlockTimers[username]);
            delete this.sessionAutoUnlockTimers[username];
        }

        if (browserId) {
            await this.releaseBrowser(browserId);
        }
    }

    // 返回会话
    // getBrowserInstances() {
    //     return this.browserInstances;
    // }

    // 策略
    async getSessionByStrategy(strategy = 'round_robin') {
        if (strategy === 'round_robin') {
            return await this.getAvailableSessions();
        }
        throw new Error(`未实现的策略: ${strategy}`);
    }
}

/**
 * Fisher–Yates 洗牌
 */
function shuffleArray(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
}

export default SessionManager;