class StreamFlixHomepage {
    constructor() {
        this.appMode = this.detectAppMode();
        this.isDesktopApp = this.appMode === 'desktop';
        this.channels = [];
        this.featuredChannels = [];
        this.continueWatching = [];
        this.popularChannels = [];
        this.allChannelsSource = [];
        this.allChannelsVisibleCount = 0;
        this.allChannelsPageSize = 0;
        this.allChannelsChunkSize = 50;
        this.channelStatusCacheKey = 'streamflix-channel-status-v1';
        this.channelStatusTtlMs = 10 * 60 * 1000;
        this.channelStatusCache = this.loadChannelStatusCache();
        this.statusProbeQueue = [];
        this.statusProbeInFlight = new Set();
        this.statusProbeWorkers = 0;
        this.maxStatusProbeWorkers = 4;
        this.relayProbeBase = this.resolveRelayProbeBase();
        this.playlists = {
            global: 'https://ghproxy.com',
            india: 'https://githubusercontent.com'
        };
        this.selectedPlaylist = localStorage.getItem('streamflix-preferred-playlist') || 'global';
        
        this.initializeElements();
        this.applyAppMode();
        this.bindEvents();
        this.loadChannels();
        this.setupSlideshow();
    }

    detectAppMode() {
        const fromDesktopBridge = (window.streamflixDesktop && window.streamflixDesktop.appMode) || '';
        const fromQuery = new URLSearchParams(window.location.search).get('mode') || '';
        const normalized = (fromDesktopBridge || fromQuery || 'web').toLowerCase();
        return normalized === 'desktop' ? 'desktop' : 'web';
    }

    applyAppMode() {
        document.body.dataset.appMode = this.appMode;
        if (!this.isDesktopApp) {
            return;
        }
        document.querySelectorAll('[data-web-only]').forEach((element) => element.remove());
    }

    initializeElements() {
        this.watchNowBtn = document.getElementById('watch-now');
        this.browseChannelsBtn = document.getElementById('browse-channels');
        this.playCustomUrlBtn = document.getElementById('play-custom-url');
        this.browseChannelsTopBtn = document.getElementById('browse-channels-top');
        this.searchInput = document.getElementById('search-input');
        this.allChannelsGrid = document.getElementById('all-channels');
        this.loadMoreHomeBtn = document.getElementById('load-more-home');
        this.continueWatchingRow = document.getElementById('continue-watching');
        this.popularChannelsRow = document.getElementById('popular-channels');
        this.categoryCards = document.querySelectorAll('.category-card');
        this.homePlaylistSelect = document.getElementById('home-playlist-select');
        this.homeMenuToggle = document.getElementById('home-menu-toggle');
        this.homeSidebar = document.getElementById('home-sidebar');
        this.homeSidebarOverlay = document.getElementById('home-sidebar-overlay');
        this.homeSidebarClose = document.getElementById('home-sidebar-close');

        if (this.homePlaylistSelect) {
            this.homePlaylistSelect.value = this.selectedPlaylist;
        }
    }

    bindEvents() {
        if (this.watchNowBtn) {
            this.watchNowBtn.addEventListener('click', () => this.startWatching());
        }
        
        if (this.browseChannelsBtn) {
            this.browseChannelsBtn.addEventListener('click', () => this.scrollToChannels());
        }

        if (this.browseChannelsTopBtn) {
            this.browseChannelsTopBtn.addEventListener('click', () => this.scrollToChannels());
        }

        if (this.playCustomUrlBtn) {
            this.playCustomUrlBtn.addEventListener('click', () => this.promptForCustomUrl());
        }
        
        if (this.searchInput) {
            this.searchInput.addEventListener('input', (e) => this.filterChannels(e.target.value));
        }

        if (this.loadMoreHomeBtn) {
            this.loadMoreHomeBtn.addEventListener('click', () => this.loadMoreAllChannels());
        }

        if (this.homePlaylistSelect) {
            this.homePlaylistSelect.addEventListener('change', (e) => {
                const nextPlaylist = e.target.value;
                this.setPreferredPlaylist(nextPlaylist);
                if (this.searchInput) {
                    this.searchInput.value = '';
                }
                this.loadChannels({ forceRefresh: true });
            });
        }

        if (this.homeMenuToggle) {
            this.homeMenuToggle.addEventListener('click', () => this.openHomeSidebar());
        }

        if (this.homeSidebarClose) {
            this.homeSidebarClose.addEventListener('click', () => this.closeHomeSidebar());
        }

        if (this.homeSidebarOverlay) {
            this.homeSidebarOverlay.addEventListener('click', () => this.closeHomeSidebar());
        }

        if (this.homeSidebar) {
            this.homeSidebar.querySelectorAll('a').forEach((link) => {
                link.addEventListener('click', () => this.closeHomeSidebar());
            });
        }
        
        // Category card clicks
        this.categoryCards.forEach(card => {
            card.addEventListener('click', (e) => {
                const category = card.dataset.category;
                this.filterByCategory(category);
            });
        });
        
        // Setup row navigation
        this.setupRowNavigation();
        
        // Event delegation for play buttons
        document.addEventListener('click', (e) => {
            if (e.target.closest('.play-button')) {
                const button = e.target.closest('.play-button');
                const channelId = button.dataset.channelId;
                console.log('🎮 Play button clicked, channel ID:', channelId);
                if (channelId && window.homepage) {
                    window.homepage.playChannel(channelId);
                } else {
                    console.error('❌ Could not play channel - missing data or homepage object');
                }
            }
        });
    }

    getChannelCacheKey() {
        return `streamflix-channels-${this.selectedPlaylist}`;
    }

    setPreferredPlaylist(type) {
        if (!this.playlists[type]) return;
        this.selectedPlaylist = type;
        localStorage.setItem('streamflix-preferred-playlist', type);
    }

    async loadChannels(options = {}) {
        const { forceRefresh = false } = options;
        try {
            // Load from localStorage first
            const cacheKey = this.getChannelCacheKey();
            const cachedChannels = localStorage.getItem(cacheKey);
            if (cachedChannels && !forceRefresh) {
                this.channels = JSON.parse(cachedChannels);
                this.processChannels();
                return;
            }
            
            const playlistUrl = this.playlists[this.selectedPlaylist] || this.playlists.global;
            console.log(`📡 Loading ${this.selectedPlaylist} playlist from homepage...`);
            const response = await fetch(playlistUrl);
            const playlistText = await response.text();
            
            this.parsePlaylist(playlistText);
            localStorage.setItem(cacheKey, JSON.stringify(this.channels));
            this.processChannels();
        } catch (error) {
            console.error('Error loading channels:', error);
            this.showErrorMessage('Failed to load channel list');
        }
    }

    parsePlaylist(playlistText) {
        const lines = playlistText.split('\n');
        this.channels = [];
        let currentChannel = null;

        for (let i = 0; i < lines.length; i++) {
            const line = lines[i].trim();
            
            if (line.startsWith('#EXTINF:')) {
                const metadata = this.parseChannelMetadata(line);
                currentChannel = {
                    ...metadata,
                    url: '',
                    id: this.channels.length
                };
            } else if (line.startsWith('http') && currentChannel) {
                currentChannel.url = line;
                if (this.isValidStreamUrl(line)) {
                    this.channels.push(currentChannel);
                }
                currentChannel = null;
            }
        }
    }

    parseChannelMetadata(extinfLine) {
        const metadata = {};
        
        // Extract channel name (everything after the last comma)
        const nameMatch = extinfLine.match(/,(.*)$/);
        metadata.name = nameMatch ? nameMatch[1].trim() : 'Unknown Channel';
        
        // Extract group/category
        const groupMatch = extinfLine.match(/group-title="([^"]*)"/i);
        metadata.group = groupMatch ? groupMatch[1] : 'General';
        
        // Extract tvg-logo
        const logoMatch = extinfLine.match(/tvg-logo="([^"]*)"/i);
        metadata.logo = logoMatch ? logoMatch[1] : '';
        
        return metadata;
    }

    isValidStreamUrl(url) {
        return url && (
            url.includes('.m3u8') || 
            url.includes('.mp4') || 
            url.includes('.ts') ||
            url.includes('youtube.com') ||
            url.includes('youtu.be')
        );
    }

    processChannels() {
        // Select featured channels (first 10)
        this.featuredChannels = this.channels.slice(0, 10);
        
        // Select popular channels (random selection)
        this.popularChannels = this.shuffleArray([...this.channels]).slice(0, 15);
        
        // Get continue watching (from localStorage or recent)
        this.continueWatching = this.getContinueWatching();
        
        this.renderAllSections();
    }

    getContinueWatching() {
        const saved = localStorage.getItem('continue-watching');
        if (saved) {
            return JSON.parse(saved);
        }
        return this.channels.slice(0, 5); // Default to first 5 channels
    }

    renderAllSections() {
        this.renderFeaturedShowcase();
        this.renderContinueWatching();
        this.renderPopularChannels();
        this.renderAllChannels();
    }

    renderFeaturedShowcase() {
        // Could implement a rotating banner here
        console.log('Featured channels ready:', this.featuredChannels.length);
    }

    renderContinueWatching() {
        if (!this.continueWatchingRow) return;
        
        this.continueWatchingRow.innerHTML = this.continueWatching
            .map(channel => this.createChannelCard(channel, 'horizontal'))
            .join('');
        this.queueVisibleChannelStatusChecks(this.continueWatching);
    }

    renderPopularChannels() {
        if (!this.popularChannelsRow) return;
        
        this.popularChannelsRow.innerHTML = this.popularChannels
            .map(channel => this.createChannelCard(channel, 'horizontal'))
            .join('');
        this.queueVisibleChannelStatusChecks(this.popularChannels);
    }

    renderAllChannels() {
        if (!this.allChannelsGrid) return;
        this.resetAllChannelsPagination(this.channels);
    }

    resetAllChannelsPagination(channels) {
        this.allChannelsSource = channels;
        this.allChannelsPageSize = channels.length > 0 ? this.allChannelsChunkSize : 0;
        this.allChannelsVisibleCount = Math.min(this.allChannelsPageSize, channels.length);
        this.renderAllChannelsPage();
    }

    renderAllChannelsPage() {
        if (!this.allChannelsGrid) return;

        if (this.allChannelsSource.length === 0) {
            this.allChannelsGrid.innerHTML = `
                <div class="no-channels-message">
                    <i class="fas fa-search"></i>
                    <p>No channels found</p>
                </div>
            `;
            this.updateHomeLoadMoreButton();
            return;
        }

        const visibleChannels = this.allChannelsSource.slice(0, this.allChannelsVisibleCount);
        this.allChannelsGrid.innerHTML = visibleChannels
            .map(channel => this.createChannelCard(channel))
            .join('');
        this.updateHomeLoadMoreButton();
        this.queueVisibleChannelStatusChecks(visibleChannels);
    }

    loadMoreAllChannels() {
        if (this.allChannelsVisibleCount >= this.allChannelsSource.length) return;
        this.allChannelsVisibleCount = Math.min(
            this.allChannelsVisibleCount + this.allChannelsPageSize,
            this.allChannelsSource.length
        );
        this.renderAllChannelsPage();
    }

    updateHomeLoadMoreButton() {
        if (!this.loadMoreHomeBtn) return;
        const hasMore = this.allChannelsVisibleCount < this.allChannelsSource.length;
        this.loadMoreHomeBtn.style.display = hasMore ? 'inline-flex' : 'none';
    }

    createChannelCard(channel, style = 'vertical') {
        const logo = channel.logo || this.getDefaultLogo(channel.group);
        const className = style === 'horizontal' ? 'channel-card-horizontal' : 'channel-card';
        const channelId = channel.id;
        const fallbackInitial = channel.name ? channel.name.charAt(0).toUpperCase() : 'TV';
        const status = this.getChannelStatus(channel.url);
        const statusLabel = status === 'live' ? 'LIVE' : status === 'dead' ? 'DEAD' : '...';
        const statusClass = status === 'live' ? 'status-live' : status === 'dead' ? 'status-dead' : 'status-checking';
        const channelKey = encodeURIComponent(channel.url || '');
        
        return `
            <div class="${className}" data-channel-id="${channelId}" data-channel-key="${channelKey}">
                <div class="channel-thumbnail">
                    <div class="channel-placeholder" style="background: ${this.getChannelColor(channel.group)}">
                        <i class="fas fa-tv"></i>
                        <span>${fallbackInitial}</span>
                    </div>
                    ${logo
                        ? `<img class="channel-thumb-img" src="${logo}" alt="${channel.name} logo" onerror="this.style.display='none'">`
                        : ''}
                    <span class="channel-live-badge ${statusClass}" data-channel-key="${channelKey}">${statusLabel}</span>
                    <div class="channel-overlay">
                        <button class="play-button" data-channel-id="${channelId}">
                            <i class="fas fa-play"></i>
                        </button>
                    </div>
                </div>
                <div class="channel-info">
                    <h3 class="channel-name">${channel.name}</h3>
                    <p class="channel-group">${channel.group}</p>
                </div>
            </div>
        `;
    }

    getChannelColor(group) {
        const colors = {
            'News': '#e50914',
            'Sports': '#00bfff',
            'Entertainment': '#ff6b6b',
            'Music': '#9b59b6',
            'Kids': '#2ecc71',
            'Movies': '#f39c12'
        };
        return colors[group] || '#6c757d';
    }

    getDefaultLogo(group) {
        // Could implement default logos based on category
        return '';
    }

    setupRowNavigation() {
        document.querySelectorAll('.row-arrow.prev').forEach(button => {
            button.addEventListener('click', (e) => {
                const row = e.target.closest('.row-section');
                this.scrollRow(row, 'left');
            });
        });
        
        document.querySelectorAll('.row-arrow.next').forEach(button => {
            button.addEventListener('click', (e) => {
                const row = e.target.closest('.row-section');
                this.scrollRow(row, 'right');
            });
        });
    }

    scrollRow(row, direction) {
        const content = row.querySelector('.row-content');
        const scrollAmount = 300;
        const scrollValue = direction === 'right' ? scrollAmount : -scrollAmount;
        content.scrollBy({ left: scrollValue, behavior: 'smooth' });
    }

    playChannel(channelId) {
        console.log('🎬 Playing channel:', channelId);
        const channel = this.channels.find(c => c.id == channelId);
        if (channel) {
            console.log('📺 Found channel:', channel.name, channel.url);
            // Save to continue watching
            this.saveContinueWatching(channel);
            
            // Navigate to player page with channel parameter
            console.log('🚀 Navigating to player page with channel:', channel.name);
            const query = new URLSearchParams({
                channel: String(channelId),
                stream: channel.url || '',
                name: channel.name || '',
                group: channel.group || '',
                logo: channel.logo || '',
                playlist: this.selectedPlaylist
            });
            const url = `./player.html?${query.toString()}`;
            console.log('📍 Navigation URL:', url);
            window.location.href = url;
        } else {
            console.error('❌ Channel not found:', channelId);
            console.log('📊 Available channels:', this.channels.map(c => ({id: c.id, name: c.name})));
            alert('Channel not found. Please try again.');
        }
    }

    saveContinueWatching(channel) {
        let continueList = this.getContinueWatching();
        // Remove if already exists, add to front
        continueList = continueList.filter(c => c.id !== channel.id);
        continueList.unshift(channel);
        // Keep only last 10
        continueList = continueList.slice(0, 10);
        localStorage.setItem('continue-watching', JSON.stringify(continueList));
    }

    startWatching() {
        // Open player without auto-selecting a channel.
        window.location.href = './player.html';
    }

    promptForCustomUrl() {
        const url = prompt('Enter a stream URL (YouTube, m3u8, mp4, etc.):');
        if (url && url.trim()) {
            const cleanUrl = url.trim();
            console.log('🔗 Playing custom URL:', cleanUrl);
            
            const query = new URLSearchParams({
                stream: cleanUrl,
                name: 'Custom Stream',
                group: 'User Input',
                playlist: this.selectedPlaylist
            });
            
            window.location.href = `./player.html?${query.toString()}`;
        }
    }

    scrollToChannels() {
        document.querySelector('.all-channels-section').scrollIntoView({
            behavior: 'smooth'
        });
    }

    filterChannels(searchTerm) {
        const filtered = this.channels.filter(channel =>
            channel.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
            channel.group.toLowerCase().includes(searchTerm.toLowerCase())
        );
        this.resetAllChannelsPagination(filtered);
    }

    filterByCategory(category) {
        const filtered = category === 'all' 
            ? this.channels 
            : this.channels.filter(channel => 
                channel.group.toLowerCase().includes(category.toLowerCase())
            );
        this.resetAllChannelsPagination(filtered);
    }

    shuffleArray(array) {
        const shuffled = [...array];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }
        return shuffled;
    }

    showErrorMessage(message) {
        const errorDiv = document.createElement('div');
        errorDiv.className = 'error-message';
        errorDiv.innerHTML = `
            <div class="error-content">
                <i class="fas fa-exclamation-circle"></i>
                <p>${message}</p>
            </div>
        `;
        document.body.appendChild(errorDiv);
        
        setTimeout(() => {
            errorDiv.remove();
        }, 5000);
    }

    resolveRelayProbeBase() {
        const fromWindow = typeof window !== 'undefined' ? (window.STREAMFLIX_RELAY_BASE || '').trim() : '';
        const meta = document.querySelector('meta[name="streamflix-relay-base"]');
        const fromMeta = meta ? (meta.content || '').trim() : '';
        const raw = fromWindow || fromMeta || '';
        return raw.replace(/\/+$/, '');
    }

    loadChannelStatusCache() {
        try {
            const raw = localStorage.getItem(this.channelStatusCacheKey);
            return raw ? JSON.parse(raw) : {};
        } catch (error) {
            return {};
        }
    }

    saveChannelStatusCache() {
        try {
            localStorage.setItem(this.channelStatusCacheKey, JSON.stringify(this.channelStatusCache));
        } catch (error) {
            // Ignore storage errors.
        }
    }

    getChannelStatus(url = '') {
        const entry = this.channelStatusCache[url];
        if (!entry) return 'checking';
        if ((Date.now() - entry.checkedAt) > this.channelStatusTtlMs) return 'checking';
        return entry.state === 'live' ? 'live' : 'dead';
    }

    queueVisibleChannelStatusChecks(channels = []) {
        channels.forEach((channel) => {
            if (!channel || !channel.url) return;
            const cached = this.channelStatusCache[channel.url];
            const fresh = cached && ((Date.now() - cached.checkedAt) <= this.channelStatusTtlMs);
            if (fresh || this.statusProbeInFlight.has(channel.url)) return;
            this.statusProbeInFlight.add(channel.url);
            this.statusProbeQueue.push(channel.url);
        });
        this.runChannelStatusWorkers();
    }

    runChannelStatusWorkers() {
        while (this.statusProbeWorkers < this.maxStatusProbeWorkers && this.statusProbeQueue.length > 0) {
            const url = this.statusProbeQueue.shift();
            this.statusProbeWorkers += 1;
            this.probeChannelStatus(url)
                .catch(() => this.setChannelStatus(url, 'dead'))
                .finally(() => {
                    this.statusProbeWorkers -= 1;
                    this.statusProbeInFlight.delete(url);
                    this.runChannelStatusWorkers();
                });
        }
    }

    async probeChannelStatus(url) {
        const target = this.buildProbeUrl(url);
        if (!target) {
            this.setChannelStatus(url, 'dead');
            return;
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort('timeout'), 6000);
        try {
            const response = await fetch(target, { cache: 'no-store', signal: controller.signal });
            if (response.ok) {
                this.setChannelStatus(url, 'live');
            } else if (this.relayEnabled && target.includes(this.relayEndpoint) && this.isHttpStreamUrl(url)) {
                // If relay probe fails for HTTP stream, try direct HTTPS upgrade probe as fallback
                const upgradedUrl = url.replace(/^http:\/\//i, 'https://');
                const directController = new AbortController();
                const directTimeout = setTimeout(() => directController.abort('timeout'), 5000);
                try {
                    const directResponse = await fetch(upgradedUrl, { method: 'HEAD', cache: 'no-store', signal: directController.signal });
                    this.setChannelStatus(url, directResponse.ok ? 'live' : 'dead');
                } catch (e) {
                    this.setChannelStatus(url, 'dead');
                } finally {
                    clearTimeout(directTimeout);
                }
            } else {
                this.setChannelStatus(url, 'dead');
            }
        } catch (error) {
            this.setChannelStatus(url, 'dead');
        } finally {
            clearTimeout(timeout);
        }
    }

    buildProbeUrl(url) {
        if (!url) return null;
        if (this.relayProbeBase) {
            const separator = this.relayProbeBase.includes('?') ? '&' : '?';
            return `${this.relayProbeBase}${separator}url=${encodeURIComponent(url)}`;
        }
        if (window.location.protocol === 'https:' && /^http:\/\//i.test(url)) {
            return null;
        }
        return url;
    }

    setChannelStatus(url, state) {
        this.channelStatusCache[url] = {
            state,
            checkedAt: Date.now()
        };
        this.saveChannelStatusCache();
        this.updateChannelStatusBadge(url, state);
    }

    updateChannelStatusBadge(url, state) {
        const key = encodeURIComponent(url || '');
        const badges = document.querySelectorAll(`.channel-live-badge[data-channel-key="${key}"]`);
        badges.forEach((badge) => {
            badge.classList.remove('status-live', 'status-dead', 'status-checking');
            if (state === 'live') {
                badge.classList.add('status-live');
                badge.textContent = 'LIVE';
            } else if (state === 'dead') {
                badge.classList.add('status-dead');
                badge.textContent = 'DEAD';
            } else {
                badge.classList.add('status-checking');
                badge.textContent = '...';
            }
        });
    }

    setupSlideshow() {
        // Could implement automatic slideshow rotation here
        console.log('Slideshow initialized');
    }

    openHomeSidebar() {
        if (!this.homeSidebar || !this.homeSidebarOverlay) return;
        this.homeSidebar.classList.add('open');
        this.homeSidebarOverlay.classList.add('visible');
        document.body.classList.add('home-sidebar-open');
    }

    closeHomeSidebar() {
        if (!this.homeSidebar || !this.homeSidebarOverlay) return;
        this.homeSidebar.classList.remove('open');
        this.homeSidebarOverlay.classList.remove('visible');
        document.body.classList.remove('home-sidebar-open');
    }
}

// Initialize homepage when DOM is loaded
document.addEventListener('DOMContentLoaded', function() {
    console.log('🏠 StreamFlix Homepage Initializing...');
    
    // Make sure no conflicting player initialization occurs
    if (typeof window.netflixPlayer === 'undefined') {
        window.homepage = new StreamFlixHomepage();
        console.log('✅ StreamFlix Homepage Ready!');
        console.log('🔧 Homepage object available:', typeof window.homepage);
        console.log('🔧 PlayChannel method:', typeof window.homepage.playChannel);
    } else {
        console.warn('⚠️ Player already initialized - skipping homepage initialization');
    }
});
