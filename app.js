// ========== CONSTANTS ==========
const CONSTANTS = {
    STORAGE_KEY: 'fm_v18_1',
    DEFAULT_PIN: '1105',
    DEBOUNCE_DELAY: 300,
    AUTO_SAVE_INTERVAL: 15000,
    MIN_SEARCH_LENGTH: 0,
    BREAK_GAP_THRESHOLD: 45,
    PDF_BUFFER_MINUTES: 60
};

// Admin PIN (Firestore'dan yüklenebilir)
let adminPin = CONSTANTS.DEFAULT_PIN;

// ========== AIRLABS API MODULE ==========
const airLabs = {
    // API Konfigürasyonu (Firestore'dan yükleniyor)
    apiKey: '',
    baseUrl: 'https://airlabs.co/api/v9',
    airportCode: 'COV', // Çukurova Havalimanı

    // Cache: Son alınan uçuş verileri
    flightCache: {},
    lastFetch: 0,
    fetchInterval: 3600000, // 1 saat (token tasarrufu - günde max 24 sorgu)
    dailyQueryCount: 0,
    lastQueryDate: null,

    // Firestore'dan API key yükle
    loadApiKey: async () => {
        if (typeof db === 'undefined') {
            console.warn('⚠️ AirLabs: Firestore bağlantısı yok');
            return false;
        }
        try {
            const doc = await db.collection('settings').doc('airlabs').get();

            if (doc.exists && doc.data() && doc.data().apiKey) {
                airLabs.apiKey = doc.data().apiKey;
                console.log('✅ AirLabs: API key Firestore\'dan yüklendi');
                return true;
            } else {
                console.warn('⚠️ AirLabs: Firestore\'da API key bulunamadı');
            }
        } catch (err) {
            console.error('❌ AirLabs API key yükleme hatası:', err);
        }
        return false;
    },

    // COV'a gelen ve COV'dan giden uçuşların program ve durum bilgilerini al
    fetchSchedules: async () => {
        // API key kontrolü - yoksa Firestore'dan yükle
        if (!airLabs.apiKey) {
            const loaded = await airLabs.loadApiKey();
            if (!loaded) {
                console.warn('⚠️ AirLabs: API key bulunamadı. Admin ayarlardan eklemeli.');
                return null;
            }
        }

        // Günlük limit kontrolü (30 sorgu/gün, her güncelleme 2 sorgu)
        const today = new Date().toDateString();
        if (airLabs.lastQueryDate !== today) {
            airLabs.dailyQueryCount = 0;
            airLabs.lastQueryDate = today;
        }

        if (airLabs.dailyQueryCount >= 28) { // 28 çünkü 2 sorgu birden yapılıyor
            console.warn('⚠️ AirLabs: Günlük sorgu limiti doldu');
            return airLabs.flightCache;
        }

        // Cache kontrolü (1 saat)
        const now = Date.now();
        if (now - airLabs.lastFetch < airLabs.fetchInterval && Object.keys(airLabs.flightCache).length > 0) {
            const remaining = Math.round((airLabs.fetchInterval - (now - airLabs.lastFetch)) / 60000);
            console.log(`⏳ AirLabs: Cache kullanılıyor, sonraki sorgu: ${remaining} dk sonra`);
            return airLabs.flightCache;
        }

        try {
            // Hem geliş hem gidiş uçuşlarını sorgula (2 sorgu)
            const arrUrl = `${airLabs.baseUrl}/schedules?arr_iata=${airLabs.airportCode}&api_key=${airLabs.apiKey}`;
            const depUrl = `${airLabs.baseUrl}/schedules?dep_iata=${airLabs.airportCode}&api_key=${airLabs.apiKey}`;

            const [arrResponse, depResponse] = await Promise.all([
                fetch(arrUrl),
                fetch(depUrl)
            ]);

            if (!arrResponse.ok || !depResponse.ok) {
                console.error('❌ AirLabs API hatası');
                return null;
            }

            const arrData = await arrResponse.json();
            const depData = await depResponse.json();

            if (arrData.error || depData.error) {
                console.error('❌ AirLabs hatası:', arrData.error?.message || depData.error?.message);
                return null;
            }

            // Her iki sonucu birleştir ve cache'le
            const allFlights = [...(arrData.response || []), ...(depData.response || [])];
            airLabs.processFlights(allFlights);
            airLabs.lastFetch = now;
            airLabs.dailyQueryCount += 2; // 2 sorgu yapıldı

            console.log(`✅ AirLabs: ${Object.keys(airLabs.flightCache).length} uçuş yüklendi (Bugün: ${airLabs.dailyQueryCount}/30 sorgu)`);
            return airLabs.flightCache;
        } catch (err) {
            console.error('❌ AirLabs API hatası:', err);
            return null;
        }
    },

    // Uçuş verilerini işle ve cache'le
    processFlights: (flights) => {
        airLabs.flightCache = {};

        flights.forEach(flight => {
            const flightId = flight.flight_iata || flight.flight_icao;
            if (!flightId) return;

            // Saat parse fonksiyonu
            const parseTime = (timeStr) => {
                if (!timeStr) return null;
                // Eğer sadece saat:dakika formatındaysa
                if (timeStr.match(/^\d{1,2}:\d{2}$/)) {
                    const [h, m] = timeStr.split(':').map(Number);
                    return h * 60 + m;
                }
                // Tam tarih formatındaysa sadece saati al
                const match = timeStr.match(/(\d{1,2}):(\d{2})(?::\d{2})?$/);
                if (match) {
                    return parseInt(match[1]) * 60 + parseInt(match[2]);
                }
                return null;
            };

            // Delay hesaplama fonksiyonu (negatif = erken, pozitif = gecikme)
            const calculateDelay = (scheduledStr, estimatedStr) => {
                const scheduledMins = parseTime(scheduledStr);
                const estimatedMins = parseTime(estimatedStr);
                if (scheduledMins !== null && estimatedMins !== null) {
                    let delay = estimatedMins - scheduledMins;
                    // Gece yarısı geçişi kontrolü
                    if (delay < -720) delay += 1440;
                    if (delay > 720) delay -= 1440;
                    return delay; // Negatif = erken, pozitif = gecikme
                }
                return 0;
            };

            // Varış delay'i (COV'a geliş)
            const arrDelayMinutes = calculateDelay(flight.arr_time, flight.arr_estimated);

            // Kalkış delay'i (COV'dan gidiş)
            const depDelayMinutes = calculateDelay(flight.dep_time, flight.dep_estimated);

            airLabs.flightCache[flightId] = {
                flightNumber: flightId,
                airline: flight.airline_iata,
                depAirport: flight.dep_iata,
                arrAirport: flight.arr_iata,
                // Kalkış bilgileri
                scheduledDep: flight.dep_time,
                estimatedDep: flight.dep_estimated || flight.dep_time,
                depDelayMinutes: depDelayMinutes,
                // Varış bilgileri
                scheduledArr: flight.arr_time,
                estimatedArr: flight.arr_estimated || flight.arr_time,
                arrDelayMinutes: arrDelayMinutes,
                // Genel delay (hangi yönde olursa olsun en büyük delay)
                delayMinutes: Math.max(arrDelayMinutes, depDelayMinutes),
                status: flight.status || 'scheduled'
            };
        });
    },

    // Belirli bir uçuşun bilgisini al
    getFlightInfo: (flightNumber) => {
        if (!flightNumber) return null;

        // Farklı formatları dene (Excel'den gelen format vs API format)
        const cleanNumber = flightNumber.replace(/\s/g, '').toUpperCase();
        const variations = [
            cleanNumber,                              // PC3001
            cleanNumber.replace(/(\D+)(\d+)/, '$1$2') // PC 3001 -> PC3001
        ];

        for (const fn of variations) {
            if (airLabs.flightCache[fn]) {
                return airLabs.flightCache[fn];
            }
        }
        return null;
    },

    // Manuel sorgu tetikleme (admin için)
    forceRefresh: async () => {
        airLabs.lastFetch = 0;
        const result = await airLabs.fetchSchedules();
        // Sonuçları Firestore'a kaydet (tüm kullanıcılar görsün)
        if (result) await airLabs.saveToFirestore();
        return result;
    },

    // Sonuçları Firestore'a kaydet
    saveToFirestore: async () => {
        if (typeof db === 'undefined') {
            console.warn('⚠️ AirLabs: Firestore bağlantısı yok (saveToFirestore)');
            return false;
        }
        try {
            console.log('💾 AirLabs: Firestore\'a kaydediliyor...');
            await db.collection('liveFlights').doc('cache').set({
                flightCache: airLabs.flightCache,
                lastFetch: airLabs.lastFetch,
                updatedAt: Date.now()
            });
            console.log('✅ AirLabs: Sonuçlar Firestore\'a kaydedildi');
            return true;
        } catch (err) {
            console.error('❌ AirLabs Firestore kayıt hatası:', err);
            return false;
        }
    },

    // Firestore'dan sonuçları yükle
    loadFromFirestore: async () => {
        if (typeof db === 'undefined') {
            console.warn('⚠️ AirLabs: Firestore bağlantısı yok (loadFromFirestore)');
            return false;
        }
        try {
            console.log('🔄 AirLabs: Firestore\'dan cache yükleniyor...');
            const doc = await db.collection('liveFlights').doc('cache').get();
            if (doc.exists) {
                const data = doc.data();
                airLabs.flightCache = data.flightCache || {};
                airLabs.lastFetch = data.lastFetch || 0;
                console.log(`✅ AirLabs: ${Object.keys(airLabs.flightCache).length} uçuş Firestore'dan yüklendi`);
                return true;
            } else {
                console.log('📭 AirLabs: Firestore\'da cache bulunamadı');
            }
        } catch (err) {
            console.error('❌ AirLabs Firestore yükleme hatası:', err);
        }
        return false;
    },

    // Cache'i temizle (sistem sıfırlandığında)
    clearCache: async () => {
        // Lokal cache'i temizle
        airLabs.flightCache = {};
        airLabs.lastFetch = 0;

        // Firestore'dan sil
        if (typeof db !== 'undefined') {
            try {
                await db.collection('liveFlights').doc('cache').delete();
                console.log('🗑️ AirLabs: Firestore cache silindi');
            } catch (err) {
                console.error('❌ AirLabs cache silme hatası:', err);
            }
        }
    }
};

// ========== ADMIN PIN FUNCTIONS ==========
// Firestore'dan PIN yükle
async function loadAdminPin() {
    if (typeof db === 'undefined') return;
    try {
        const doc = await db.collection('settings').doc('admin').get();
        if (doc.exists && doc.data() && doc.data().pin) {
            adminPin = doc.data().pin;
            console.log('✅ Admin PIN Firestore\'dan yüklendi');
        }
    } catch (err) {
        console.error('❌ Admin PIN yükleme hatası:', err);
    }
}

// Firestore'a PIN kaydet
async function saveAdminPin(newPin) {
    if (typeof db === 'undefined') return false;
    try {
        await db.collection('settings').doc('admin').set({ pin: newPin }, { merge: true });
        adminPin = newPin;
        console.log('✅ Admin PIN Firestore\'a kaydedildi');
        return true;
    } catch (err) {
        console.error('❌ Admin PIN kaydetme hatası:', err);
        return false;
    }
}

const app = {
    isAdmin: false, // Admin mi yoksa kullanıcı mı - Firebase'e GİTMEYECEK
    canWrite: true, // Yazma izni - visibility kontrolü için

    // LOKAL FİLTRELER - Firebase'e GİTMEYECEK, herkes kendi filtresini bağımsız seçer
    localFilters: {
        filterMode: 'all', // all/arr/dep - kişisel
        staffFilter: null, // Personel filtresi - kişisel
        showCompleted: true, // Tamamlananları göster - kişisel
        showUpdatedOnly: false // Güncellenmiş filtresi - kişisel
    },

    // PAYLAŞILAN VERİ - Firebase'e kaydedilecek (Admin belirler)
    state: {
        flights: [],
        shift: 'day', // Vardiya - Admin belirler, herkes görür
        customStart: 480, // 08:00 - Admin belirler
        customEnd: 1200, // 20:00 - Admin belirler
        staff: ['AHMET Y.', 'MEHMET K.', 'AYŞE D.', 'FATMA S.', 'CAN B.'],
        assignments: {}, gates: {}, overrides: {}, completed: [], delayed: {}, timeChanges: {},
        baseDate: null,
        history: [], // Son 10 işlem için geri alma
        flightHistory: {}, // Uçuş değişiklik geçmişi
        lastUpdated: 0 // Son güncelleme timestamp'ı - çakışma kontrolü için
    },
    init: () => {
        app.data.load(); app.ui.startClock(); app.ui.renderStaff(); app.ui.updateShiftUI(); app.ui.setFilter(app.localFilters.filterMode); app.ui.updateCompletedBtn(); app.ui.updateHeaderShiftLabel();
        const updateDate = () => { document.getElementById('liveDate').innerText = new Date().toLocaleDateString('tr-TR'); };
        updateDate(); setInterval(updateDate, 60000);
        const searchInput = document.getElementById('searchInput'); const searchInputMobile = document.getElementById('searchInputMobile');
        let searchTimeout; const handleSearch = (e) => { clearTimeout(searchTimeout); searchTimeout = setTimeout(() => { const val = e.target.value; if (e.target.id === 'searchInput') { document.getElementById('clearSearchBtn').classList.toggle('hidden', val.length === 0); if (searchInputMobile) searchInputMobile.value = val; } else { if (searchInput) searchInput.value = val; document.getElementById('clearSearchBtn').classList.toggle('hidden', val.length === 0); } app.ui.render(); }, 200); };
        if (searchInput) searchInput.addEventListener('input', handleSearch, { passive: true }); if (searchInputMobile) searchInputMobile.addEventListener('input', handleSearch, { passive: true });

        // Show Login Screen if not logged in this session
        if (!sessionStorage.getItem('isLoggedIn')) {
            document.getElementById('loginScreen').classList.remove('hidden');
        } else {
            // Session'dan admin durumunu yükle
            app.isAdmin = sessionStorage.getItem('isAdmin') === 'true';
            document.getElementById('appContent').classList.remove('hidden');
            document.getElementById('appContent').classList.remove('opacity-0');
            document.getElementById('loginScreen').classList.add('hidden');
            // UI'ı güncelle (admin/kullanıcı göstergesi)
            setTimeout(() => app.ui.updateAdminUI(), 100);
        }

        // Ctrl+Z kısayolu
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 'z') { e.preventDefault(); app.logic.undo(); }
        });

        // Page Visibility API - Sayfa görünmez olunca yazma kilitle, geri gelince kontrol et
        document.addEventListener('visibilitychange', async () => {
            if (document.hidden) {
                // Sayfa görünmez oldu - yazma izni kaldır
                app.canWrite = false;
                console.log('🔒 Sayfa gizlendi - yazma kilitledi');
            } else {
                // Sayfa tekrar görünür oldu - çakışma kontrolü yap
                console.log('👁️ Sayfa görünür oldu - çakışma kontrolü yapılıyor...');

                if (typeof db !== 'undefined' && app.isAdmin) {
                    try {
                        const docSnap = await db.collection('appState').doc('main').get();
                        const remoteTimestamp = docSnap.exists ? (docSnap.data().lastUpdated || 0) : 0;

                        // Eğer remote daha yeni ise (5 saniyeden fazla fark)
                        if (remoteTimestamp > app.state.lastUpdated && (remoteTimestamp - app.state.lastUpdated) > 5000) {
                            console.log('⚠️ Uzaktan yeni veri tespit edildi!');
                            app.ui.showConflictWarning(remoteTimestamp);
                        } else {
                            // Çakışma yok - yazma iznini geri ver
                            app.canWrite = true;
                            console.log('✅ Çakışma yok - yazma izni verildi');
                        }
                    } catch (err) {
                        console.error('Visibility check error:', err);
                        app.canWrite = true; // Hata durumunda izin ver
                    }
                } else {
                    app.canWrite = true; // Admin değilse veya Firestore yoksa izin ver
                }
            }
        });

        setInterval(app.data.save, CONSTANTS.AUTO_SAVE_INTERVAL);

        // Service Worker kaydı (PWA)
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('./sw.js')
                .then(reg => console.log('✅ Service Worker kaydedildi'))
                .catch(err => console.log('❌ SW hatası:', err));
        }
    },
    ui: {
        // Kullanıcı girişi (sadece okuma)
        loginAsUser: () => {
            app.isAdmin = false;
            sessionStorage.setItem('isLoggedIn', 'true');
            sessionStorage.setItem('isAdmin', 'false');
            app.ui.completeLogin();
            app.ui.toast('Kullanıcı olarak giriş yapıldı', 'info');
        },

        // Admin girişi (tam yetki)
        loginAsAdmin: () => {
            const pin = document.getElementById('pinInput').value;
            if (pin === adminPin) {
                app.isAdmin = true;
                sessionStorage.setItem('isLoggedIn', 'true');
                sessionStorage.setItem('isAdmin', 'true');
                app.ui.completeLogin();
                app.ui.toast('Admin olarak giriş yapıldı', 'success');
            } else {
                const box = document.querySelector('#loginScreen .glass');
                box.classList.add('animate-shake');
                document.getElementById('pinInput').value = '';
                setTimeout(() => box.classList.remove('animate-shake'), 500);
                app.ui.toast('Hatalı PIN', 'error');
            }
        },

        // Giriş tamamlama animasyonu
        completeLogin: () => {
            const login = document.getElementById('loginScreen');
            login.style.opacity = '0';
            login.style.transition = 'opacity 0.5s';
            setTimeout(() => {
                login.classList.add('hidden');
                const content = document.getElementById('appContent');
                content.classList.remove('hidden');
                setTimeout(() => content.classList.remove('opacity-0'), 50);
                app.ui.updateAdminUI();
                app.ui.render(); // Kartları yeniden çiz (admin kontrolü ile)
            }, 500);
        },

        // Saat input focus handler - değeri temizle ve placeholder göster
        handleTimeInputFocus: (input) => {
            if (!app.isAdmin) return;
            input.dataset.original = input.value; // Orijinal değeri sakla
            input.value = '';
            input.placeholder = 'HH:MM';
        },

        // Saat input blur handler - değeri kontrol et ve güncelle veya geri al
        handleTimeInputBlur: (input, flightId) => {
            if (!app.isAdmin) return;
            const value = input.value.trim();
            const original = input.dataset.original;

            // Değer girilmemişse veya geçersizse orijinal değere dön
            if (!value || value === '' || value === 'HH:MM') {
                input.value = original;
                input.placeholder = '';
                return;
            }

            // Sadece rakam girilmişse formatla (1745 -> 17:45)
            let formatted = value;
            if (/^\d{4}$/.test(value)) {
                formatted = value.slice(0, 2) + ':' + value.slice(2);
            } else if (/^\d{3}$/.test(value)) {
                formatted = '0' + value.slice(0, 1) + ':' + value.slice(1);
            }

            // Format kontrolü (HH:MM)
            if (!/^[0-2]?[0-9]:[0-5][0-9]$/.test(formatted)) {
                input.value = original;
                input.placeholder = '';
                app.ui.toast('Geçersiz saat formatı (HH:MM)', 'error');
                return;
            }

            // Değer değiştiyse güncelle
            if (formatted !== original) {
                app.logic.updateFlightTime(flightId, formatted);
            } else {
                input.value = original;
            }
            input.placeholder = '';
        },

        // Saat input oninput handler - otomatik ":" ekleme
        handleTimeInputChange: (input) => {
            let v = input.value.replace(/[^0-9:]/g, ''); // Sadece rakam ve ":"

            // 2 rakam girildiyse otomatik ":" ekle
            if (v.length === 2 && !v.includes(':')) {
                v = v + ':';
            }

            // Maksimum 5 karakter (HH:MM)
            if (v.length > 5) v = v.slice(0, 5);

            input.value = v;
        },


        // Admin UI güncellemesi (düzenleme kontrollerini gizle/göster)
        updateAdminUI: () => {
            const isAdmin = app.isAdmin;
            // Admin değilse düzenleme butonlarını gizle
            document.querySelectorAll('.admin-only').forEach(el => {
                el.style.display = isAdmin ? '' : 'none';
            });

            // Mobil bottom bar rol butonunu güncelle
            const mobileRoleIcon = document.getElementById('mobileRoleIcon');
            const mobileRoleIconI = document.getElementById('mobileRoleIconI');
            const mobileRoleLabel = document.getElementById('mobileRoleLabel');
            if (mobileRoleIcon && mobileRoleIconI && mobileRoleLabel) {
                if (isAdmin) {
                    mobileRoleIcon.className = 'w-10 h-10 rounded-full bg-amber-500/10 flex items-center justify-center';
                    mobileRoleIconI.className = 'fa-solid fa-user-shield text-amber-400 text-lg';
                    mobileRoleLabel.className = 'text-[9px] text-amber-400 font-bold uppercase';
                    mobileRoleLabel.textContent = 'Admin';
                } else {
                    mobileRoleIcon.className = 'w-10 h-10 rounded-full bg-slate-500/10 flex items-center justify-center';
                    mobileRoleIconI.className = 'fa-solid fa-eye text-slate-400 text-lg';
                    mobileRoleLabel.className = 'text-[9px] text-slate-400 font-bold uppercase';
                    mobileRoleLabel.textContent = 'Kullanıcı';
                }
            }

            // Desktop için floating badge (sadece md ve üstü)
            const existingBadge = document.getElementById('roleBadge');
            if (existingBadge) existingBadge.remove();

            const badge = document.createElement('div');
            badge.id = 'roleBadge';
            badge.className = `hidden md:flex fixed bottom-4 right-32 px-3 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider z-[90] cursor-pointer transition hover:scale-105 items-center ${isAdmin ? 'bg-amber-500/20 text-amber-400 border border-amber-500/30 hover:bg-amber-500/30' : 'bg-slate-500/20 text-slate-400 border border-slate-500/30 hover:bg-slate-500/30'}`;
            badge.innerHTML = isAdmin ? '<i class="fa-solid fa-user-shield mr-1"></i> ADMIN <i class="fa-solid fa-repeat ml-2 opacity-50"></i>' : '<i class="fa-solid fa-eye mr-1"></i> KULLANICI <i class="fa-solid fa-repeat ml-2 opacity-50"></i>';
            badge.title = isAdmin ? 'Kullanıcı moduna geç' : 'Admin moduna geç (PIN gerekli)';
            badge.onclick = () => app.ui.showRoleSwitchModal();

            // Admin için AirLabs Canlı Güncelle butonu
            const existingAirLabsBtn = document.getElementById('airLabsRefreshBtn');
            if (existingAirLabsBtn) existingAirLabsBtn.remove();

            if (isAdmin) {
                const airLabsBtn = document.createElement('button');
                airLabsBtn.id = 'airLabsRefreshBtn';
                airLabsBtn.className = 'hidden md:flex fixed bottom-4 right-80 px-3 py-2 rounded-xl text-[10px] font-bold uppercase tracking-wider z-[90] cursor-pointer transition hover:scale-105 items-center bg-cyan-500/20 text-cyan-400 border border-cyan-500/30 hover:bg-cyan-500/30';
                airLabsBtn.innerHTML = '<i class="fa-solid fa-satellite-dish mr-1"></i> CANLI GÜNCELLE';
                airLabsBtn.title = 'AirLabs API\'den canlı uçuş bilgilerini güncelle';
                airLabsBtn.onclick = async () => {
                    airLabsBtn.innerHTML = '<i class="fa-solid fa-spinner fa-spin mr-1"></i> GÜNCELLENİYOR...';
                    await airLabs.forceRefresh();
                    app.ui.render(); // Kartları yenile
                    airLabsBtn.innerHTML = '<i class="fa-solid fa-satellite-dish mr-1"></i> CANLI GÜNCELLE';
                    app.ui.toast('Canlı bilgiler güncellendi!', 'success');
                };
                document.body.appendChild(airLabsBtn);
            }
            document.body.appendChild(badge);
        },

        // Menüden canlı güncelle (mobile ve desktop)
        refreshLiveInfo: async () => {
            const btn = document.getElementById('menuLiveRefreshBtn');
            if (btn) btn.innerHTML = '<div class="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center text-cyan-500"><i class="fa-solid fa-spinner fa-spin"></i></div>Güncelleniyor...';

            await airLabs.forceRefresh();
            app.ui.render();
            app.ui.toast('Canlı bilgiler güncellendi!', 'success');

            if (btn) btn.innerHTML = '<div class="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center text-cyan-500 group-hover:bg-cyan-500 group-hover:text-white transition"><i class="fa-solid fa-satellite-dish"></i></div>Canlı Güncelle';

            // Menüyü kapat
            app.ui.toggleMenu();
        },

        // Rol geçiş modalı
        showRoleSwitchModal: () => {
            if (app.isAdmin) {
                // Admin -> Kullanıcı (direkt geçiş)
                app.isAdmin = false;
                sessionStorage.setItem('isAdmin', 'false');
                app.ui.updateAdminUI();
                app.ui.render();
                app.ui.toast('Kullanıcı moduna geçildi', 'info');
            } else {
                // Kullanıcı -> Admin (özel PIN modalı göster)
                app.ui.showPinModal();
            }
        },

        // Özel PIN giriş modalı
        showPinModal: () => {
            // Mevcut modal varsa kaldır
            const existing = document.getElementById('pinSwitchModal');
            if (existing) existing.remove();

            const modal = document.createElement('div');
            modal.id = 'pinSwitchModal';
            modal.className = 'fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-4';
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
            modal.innerHTML = `
                <div class="bg-slate-900/95 rounded-2xl border border-white/10 shadow-2xl p-6 max-w-sm w-full animate-slide-up">
                    <div class="text-center mb-6">
                        <div class="w-14 h-14 bg-amber-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
                            <i class="fa-solid fa-user-shield text-2xl text-amber-400"></i>
                        </div>
                        <h3 class="text-lg font-bold text-white mb-2">Admin Girişi</h3>
                        <p class="text-sm text-gray-400">Admin moduna geçmek için PIN girin</p>
                    </div>
                    <div class="space-y-4">
                        <input type="password" id="pinSwitchInput" maxlength="4" inputmode="numeric" pattern="[0-9]*" 
                            class="w-full bg-slate-800 border border-white/10 rounded-xl px-4 py-4 text-center text-2xl text-white font-mono tracking-[0.5em] focus:border-amber-500 outline-none" 
                            placeholder="••••" autofocus>
                        <div class="flex gap-3">
                            <button onclick="document.getElementById('pinSwitchModal').remove()" 
                                class="flex-1 py-3 bg-white/5 hover:bg-white/10 text-gray-400 rounded-xl font-bold text-sm transition">
                                Vazgeç
                            </button>
                            <button onclick="app.ui.verifyPinSwitch()" 
                                class="flex-1 py-3 bg-amber-600 hover:bg-amber-500 text-white rounded-xl font-bold text-sm shadow-lg shadow-amber-600/30 transition">
                                <i class="fa-solid fa-unlock mr-2"></i>Giriş
                            </button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);

            // Input'a focus ve Enter tuşu desteği
            setTimeout(() => {
                const input = document.getElementById('pinSwitchInput');
                if (input) {
                    input.focus();
                    input.onkeyup = (e) => { if (e.key === 'Enter') app.ui.verifyPinSwitch(); };
                }
            }, 100);
        },

        // PIN doğrulama
        verifyPinSwitch: () => {
            const input = document.getElementById('pinSwitchInput');
            const modal = document.getElementById('pinSwitchModal');
            if (!input) return;

            if (input.value === adminPin) {
                app.isAdmin = true;
                sessionStorage.setItem('isAdmin', 'true');
                if (modal) modal.remove();
                app.ui.updateAdminUI();
                app.ui.render();
                app.ui.toast('Admin moduna geçildi', 'success');
            } else {
                input.value = '';
                input.classList.add('animate-shake', 'border-red-500');
                setTimeout(() => input.classList.remove('animate-shake', 'border-red-500'), 500);
                app.ui.toast('Hatalı PIN', 'error');
            }
        },

        // PIN Değiştirme Modalı (Admin için)
        showChangePinModal: () => {
            if (!app.isAdmin) {
                app.ui.toast('Bu işlem için admin olmalısınız', 'error');
                return;
            }

            const existing = document.getElementById('changePinModal');
            if (existing) existing.remove();

            const modal = document.createElement('div');
            modal.id = 'changePinModal';
            modal.className = 'fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-4';
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
            modal.innerHTML = `
                <div class="bg-slate-900/95 rounded-2xl border border-white/10 shadow-2xl p-6 max-w-sm w-full animate-slide-up">
                    <div class="text-center mb-6">
                        <div class="w-14 h-14 bg-purple-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
                            <i class="fa-solid fa-key text-2xl text-purple-400"></i>
                        </div>
                        <h3 class="text-lg font-bold text-white mb-2">PIN Değiştir</h3>
                        <p class="text-sm text-gray-400">Yeni admin PIN'inizi girin</p>
                    </div>
                    <div class="space-y-4">
                        <div>
                            <label class="text-xs text-gray-500 mb-1 block">Mevcut PIN</label>
                            <input type="password" id="currentPinInput" maxlength="4" inputmode="numeric" pattern="[0-9]*" 
                                class="w-full bg-slate-800 border border-white/10 rounded-xl px-4 py-3 text-center text-xl text-white font-mono tracking-[0.5em] focus:border-purple-500 outline-none" 
                                placeholder="••••">
                        </div>
                        <div>
                            <label class="text-xs text-gray-500 mb-1 block">Yeni PIN</label>
                            <input type="password" id="newPinInput" maxlength="4" inputmode="numeric" pattern="[0-9]*" 
                                class="w-full bg-slate-800 border border-white/10 rounded-xl px-4 py-3 text-center text-xl text-white font-mono tracking-[0.5em] focus:border-purple-500 outline-none" 
                                placeholder="••••">
                        </div>
                        <div class="flex gap-3">
                            <button onclick="document.getElementById('changePinModal').remove()" 
                                class="flex-1 py-3 bg-white/5 hover:bg-white/10 text-gray-400 rounded-xl font-bold text-sm transition">
                                Vazgeç
                            </button>
                            <button onclick="app.ui.saveNewPin()" 
                                class="flex-1 py-3 bg-purple-600 hover:bg-purple-500 text-white rounded-xl font-bold text-sm shadow-lg shadow-purple-600/30 transition">
                                <i class="fa-solid fa-save mr-2"></i>Kaydet
                            </button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
            setTimeout(() => document.getElementById('currentPinInput')?.focus(), 100);
        },

        // Yeni PIN kaydet
        saveNewPin: async () => {
            const currentInput = document.getElementById('currentPinInput');
            const newInput = document.getElementById('newPinInput');
            const modal = document.getElementById('changePinModal');

            if (!currentInput || !newInput) return;

            // Mevcut PIN kontrolü
            if (currentInput.value !== adminPin) {
                currentInput.value = '';
                currentInput.classList.add('animate-shake', 'border-red-500');
                setTimeout(() => currentInput.classList.remove('animate-shake', 'border-red-500'), 500);
                app.ui.toast('Mevcut PIN hatalı', 'error');
                return;
            }

            // Yeni PIN kontrolü
            if (newInput.value.length !== 4) {
                newInput.classList.add('animate-shake', 'border-red-500');
                setTimeout(() => newInput.classList.remove('animate-shake', 'border-red-500'), 500);
                app.ui.toast('PIN 4 haneli olmalı', 'error');
                return;
            }

            // Kaydet
            const success = await saveAdminPin(newInput.value);
            if (success) {
                if (modal) modal.remove();
                app.ui.toast('PIN başarıyla değiştirildi', 'success');
            } else {
                app.ui.toast('PIN kaydedilemedi', 'error');
            }
        },

        // Personel Performans Raporu
        showPerformanceReport: (filter = 'today') => {
            const modal = document.getElementById('performanceModal');
            const content = document.getElementById('performanceContent');
            const total = document.getElementById('performanceTotal');
            if (!modal || !content) return;

            // Filtre butonlarını güncelle
            ['today', 'week', 'month', 'all'].forEach(f => {
                const btn = document.getElementById('perfFilter' + f.charAt(0).toUpperCase() + f.slice(1));
                if (btn) {
                    if (f === filter) {
                        btn.className = 'flex-1 py-2 px-3 bg-blue-500/20 text-blue-400 border border-blue-500/30 rounded-lg text-sm font-bold hover:bg-blue-500/30 transition';
                    } else {
                        btn.className = 'flex-1 py-2 px-3 bg-white/5 text-gray-400 border border-white/10 rounded-lg text-sm font-bold hover:bg-white/10 transition';
                    }
                }
            });

            // Loading göster
            content.innerHTML = '<div class="text-center py-8"><i class="fa-solid fa-spinner fa-spin text-2xl text-blue-400"></i><p class="text-gray-500 mt-2">Yükleniyor...</p></div>';
            total.innerHTML = '';
            modal.classList.remove('hidden');

            // Bugün için mevcut state'den oku
            if (filter === 'today') {
                const counts = {};
                app.state.staff.forEach(s => counts[s] = 0);
                app.state.completed.forEach(fid => {
                    const staffName = app.state.assignments[fid];
                    if (staffName && counts.hasOwnProperty(staffName)) {
                        counts[staffName]++;
                    }
                });
                app.ui.renderPerformanceChart(counts, 'Bugün');
                return;
            }

            // Haftalık/Aylık için Firestore arşivinden oku
            if (typeof db !== 'undefined') {
                db.collection('statsArchive').get()
                    .then(querySnapshot => {
                        const archive = {};
                        querySnapshot.forEach(doc => {
                            archive[doc.id] = doc.data();
                        });
                        const now = new Date();
                        let startDate;

                        if (filter === 'week') {
                            startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
                        } else if (filter === 'month') {
                            startDate = new Date(now.getFullYear(), now.getMonth(), 1);
                        } else {
                            startDate = new Date(0); // Tümü
                        }

                        // Tarihleri filtrele ve topla
                        const counts = {};
                        app.state.staff.forEach(s => counts[s] = 0);

                        Object.entries(archive).forEach(([dateStr, dayStats]) => {
                            const date = new Date(dateStr);
                            if (date >= startDate) {
                                Object.entries(dayStats).forEach(([name, count]) => {
                                    if (counts.hasOwnProperty(name)) {
                                        counts[name] += count;
                                    } else {
                                        counts[name] = count;
                                    }
                                });
                            }
                        });

                        // Bugünkü verileri de ekle (henüz arşivlenmemiş olabilir)
                        const todayStr = new Date().toISOString().split('T')[0];
                        if (!archive[todayStr]) {
                            app.state.completed.forEach(fid => {
                                const staffName = app.state.assignments[fid];
                                if (staffName && counts.hasOwnProperty(staffName)) {
                                    counts[staffName]++;
                                }
                            });
                        }

                        const filterLabel = filter === 'week' ? 'Bu Hafta' : filter === 'month' ? 'Bu Ay' : 'Toplam';
                        app.ui.renderPerformanceChart(counts, filterLabel);
                    })
                    .catch(err => {
                        console.error('Arşiv okuma hatası:', err);
                        content.innerHTML = '<div class="text-center py-8 text-red-400"><i class="fa-solid fa-exclamation-triangle text-2xl"></i><p class="mt-2">Arşiv okunamadı</p></div>';
                    });
            } else {
                content.innerHTML = '<div class="text-center py-8 text-amber-400"><i class="fa-solid fa-cloud-slash text-2xl"></i><p class="mt-2">Firestore bağlantısı yok</p></div>';
            }
        },

        // Performans chart'ını render et (yardımcı fonksiyon)
        renderPerformanceChart: (counts, filterLabel) => {
            const content = document.getElementById('performanceContent');
            const total = document.getElementById('performanceTotal');

            const maxCount = Math.max(...Object.values(counts), 1);
            let totalCompleted = 0;

            const sortedStaff = Object.entries(counts).sort((a, b) => b[1] - a[1]);
            content.innerHTML = sortedStaff.map(([name, count]) => {
                totalCompleted += count;
                const percentage = (count / maxCount) * 100;
                const barColor = count === maxCount && count > 0 ? 'bg-emerald-500' : 'bg-blue-500';
                return `
                    <div class="bg-white/5 rounded-xl p-3 border border-white/5 hover:border-white/10 transition">
                        <div class="flex justify-between items-center mb-2">
                            <span class="font-bold text-white flex items-center gap-2">
                                <span class="w-8 h-8 rounded-lg bg-blue-500/20 flex items-center justify-center text-blue-400">
                                    <i class="fa-solid fa-user text-xs"></i>
                                </span>
                                ${name}
                            </span>
                            <span class="text-lg font-bold ${count > 0 ? 'text-emerald-400' : 'text-gray-500'}">${count}</span>
                        </div>
                        <div class="h-2 bg-white/10 rounded-full overflow-hidden">
                            <div class="${barColor} h-full rounded-full transition-all duration-500" style="width: ${percentage}%"></div>
                        </div>
                    </div>
                `;
            }).join('');

            total.innerHTML = `
                <div class="text-gray-400 text-sm">${filterLabel} Tamamlanan</div>
                <div class="text-3xl font-bold text-emerald-400">${totalCompleted}</div>
                <div class="text-xs text-gray-500 mt-1">${Object.keys(counts).length} personel</div>
            `;
        },

        // İstatistik düzenleme modalı (Admin)
        showStatsEditor: () => {
            if (!app.isAdmin) {
                app.ui.toast('Bu işlem için admin yetkisi gerekli', 'error');
                return;
            }

            // Performans modalını kapat
            document.getElementById('performanceModal')?.classList.add('hidden');

            // Firestore'dan arşiv verilerini çek
            if (typeof db === 'undefined') {
                app.ui.toast('Firestore bağlantısı yok', 'error');
                return;
            }

            app.ui.toast('Arşiv yükleniyor...', 'info');

            // Index gerektirmeden tüm dökümanları al, client-side sırala
            db.collection('statsArchive').get()
                .then(querySnapshot => {
                    const days = [];
                    querySnapshot.forEach(doc => {
                        days.push({ date: doc.id, data: doc.data() });
                    });

                    // Client-side sıralama (en yeni en üstte)
                    days.sort((a, b) => b.date.localeCompare(a.date));

                    if (days.length === 0) {
                        app.ui.toast('Arşivde veri yok. Önce "Arşivle ve Sıfırla" yapmalısın.', 'warning');
                        return;
                    }

                    // Düzenleme modalını oluştur
                    const existing = document.getElementById('statsEditorModal');
                    if (existing) existing.remove();

                    const modal = document.createElement('div');
                    modal.id = 'statsEditorModal';
                    modal.className = 'fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-4';
                    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

                    const daysHtml = days.map(d => `
                        <button onclick="app.ui.loadStatsForEdit('${d.date}')" 
                            class="stats-day-btn w-full text-left p-3 rounded-lg bg-white/5 hover:bg-white/10 border border-white/10 transition flex justify-between items-center group">
                            <span class="font-mono text-sm">${d.date}</span>
                            <span class="text-xs text-gray-500 group-hover:text-gray-300">${Object.keys(d.data).length} personel</span>
                        </button>
                    `).join('');

                    modal.innerHTML = `
                        <div class="bg-slate-900/95 rounded-2xl border border-white/10 shadow-2xl w-full max-w-md max-h-[85vh] overflow-hidden">
                            <div class="p-4 border-b border-white/10 flex justify-between items-center bg-gradient-to-r from-amber-500/10 to-amber-600/5">
                                <div class="flex items-center gap-3">
                                    <div class="w-10 h-10 rounded-xl bg-amber-500/20 border border-amber-500/30 flex items-center justify-center">
                                        <i class="fa-solid fa-pen-to-square text-amber-400"></i>
                                    </div>
                                    <div>
                                        <h3 class="font-bold text-white">İstatistik Düzenleme</h3>
                                        <p class="text-xs text-gray-400">Arşivlenmiş günleri düzenle</p>
                                    </div>
                                </div>
                                <button onclick="document.getElementById('statsEditorModal').remove()" class="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-gray-400 hover:text-white transition">
                                    <i class="fa-solid fa-times"></i>
                                </button>
                            </div>
                            <div id="statsEditorContent" class="p-4 space-y-2 max-h-[60vh] overflow-y-auto custom-scroll">
                                <button onclick="app.ui.showAddStatsDay()" 
                                    class="w-full p-3 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 border border-emerald-500/30 transition flex items-center justify-center gap-2 text-emerald-400 font-bold mb-4">
                                    <i class="fa-solid fa-plus"></i>
                                    Yeni Gün Ekle
                                </button>
                                <p class="text-xs text-gray-500 mb-3">Düzenlemek istediğin günü seç:</p>
                                ${daysHtml.length > 0 ? daysHtml : '<p class="text-center text-gray-500 py-4">Henüz arşivlenmiş gün yok</p>'}
                            </div>
                        </div>
                    `;
                    document.body.appendChild(modal);
                })
                .catch(err => {
                    console.error('Arşiv yüklenemedi:', err);
                    app.ui.toast('Arşiv yüklenemedi', 'error');
                });
        },

        // Seçili günün verilerini düzenleme için yükle
        loadStatsForEdit: (dateStr) => {
            db.collection('statsArchive').doc(dateStr).get()
                .then(doc => {
                    if (!doc.exists) {
                        app.ui.toast('Veri bulunamadı', 'error');
                        return;
                    }

                    const data = doc.data();
                    const content = document.getElementById('statsEditorContent');

                    const staffHtml = Object.entries(data).map(([name, count]) => `
                        <div class="flex items-center gap-3 p-2 rounded-lg bg-white/5 border border-white/10">
                            <div class="flex-1">
                                <span class="text-sm text-white font-medium">${name}</span>
                            </div>
                            <input type="number" id="stat_${name.replace(/[^a-zA-Z0-9]/g, '_')}" 
                                value="${count}" min="0" 
                                class="w-16 bg-slate-800 border border-white/20 rounded px-2 py-1 text-center text-white text-sm focus:border-amber-500 focus:outline-none">
                        </div>
                    `).join('');

                    content.innerHTML = `
                        <div class="flex items-center gap-2 mb-4">
                            <button onclick="app.ui.showStatsEditor()" class="text-gray-400 hover:text-white">
                                <i class="fa-solid fa-arrow-left"></i>
                            </button>
                            <span class="font-mono text-amber-400 font-bold">${dateStr}</span>
                        </div>
                        <div class="space-y-2 mb-4" id="statsEditFields">
                            ${staffHtml}
                        </div>
                        <div class="flex gap-2">
                            <button onclick="app.ui.saveEditedStats('${dateStr}')" 
                                class="flex-1 py-3 px-4 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-bold rounded-xl transition shadow-lg shadow-emerald-600/20">
                                <i class="fa-solid fa-check mr-2"></i>Kaydet
                            </button>
                            <button onclick="app.ui.deleteStatsDay('${dateStr}')" 
                                class="py-3 px-4 bg-red-500/20 hover:bg-red-500/30 text-red-400 font-bold rounded-xl transition border border-red-500/30">
                                <i class="fa-solid fa-trash"></i>
                            </button>
                        </div>
                    `;

                    // Staff isimlerini sakla
                    window._editingStatsStaff = Object.keys(data);
                })
                .catch(err => {
                    console.error('Veri yüklenemedi:', err);
                    app.ui.toast('Veri yüklenemedi', 'error');
                });
        },

        // Düzenlenmiş istatistikleri kaydet
        saveEditedStats: (dateStr) => {
            const staffNames = window._editingStatsStaff || [];
            const newData = {};

            staffNames.forEach(name => {
                const input = document.getElementById('stat_' + name.replace(/[^a-zA-Z0-9]/g, '_'));
                if (input) {
                    newData[name] = parseInt(input.value) || 0;
                }
            });

            db.collection('statsArchive').doc(dateStr).set(newData)
                .then(() => {
                    app.ui.toast('İstatistikler güncellendi!', 'success');
                    document.getElementById('statsEditorModal')?.remove();
                })
                .catch(err => {
                    console.error('Kaydetme hatası:', err);
                    app.ui.toast('Kaydetme hatası', 'error');
                });
        },

        // Bir günün istatistiklerini sil
        deleteStatsDay: (dateStr) => {
            if (!confirm(`${dateStr} tarihindeki tüm istatistikler silinecek. Emin misin?`)) return;

            db.collection('statsArchive').doc(dateStr).delete()
                .then(() => {
                    app.ui.toast('Silindi!', 'success');
                    app.ui.showStatsEditor(); // Listeyi yenile
                })
                .catch(err => {
                    console.error('Silme hatası:', err);
                    app.ui.toast('Silme hatası', 'error');
                });
        },

        // Yeni gün ekle formu
        showAddStatsDay: () => {
            const content = document.getElementById('statsEditorContent');
            const today = new Date().toISOString().split('T')[0];

            // Mevcut personel listesini al
            const staffList = app.state.staff || [];

            const staffHtml = staffList.map(name => `
                <div class="flex items-center gap-3 p-2 rounded-lg bg-white/5 border border-white/10">
                    <div class="flex-1">
                        <span class="text-sm text-white font-medium">${name}</span>
                    </div>
                    <input type="number" id="newstat_${name.replace(/[^a-zA-Z0-9]/g, '_')}" 
                        value="0" min="0" 
                        class="w-16 bg-slate-800 border border-white/20 rounded px-2 py-1 text-center text-white text-sm focus:border-emerald-500 focus:outline-none">
                </div>
            `).join('');

            content.innerHTML = `
                <div class="flex items-center gap-2 mb-4">
                    <button onclick="app.ui.showStatsEditor()" class="text-gray-400 hover:text-white">
                        <i class="fa-solid fa-arrow-left"></i>
                    </button>
                    <span class="text-emerald-400 font-bold">Yeni Gün Ekle</span>
                </div>
                
                <div class="mb-4">
                    <label class="text-xs text-gray-400 block mb-2">Tarih Seç:</label>
                    <input type="date" id="newStatsDate" value="${today}" 
                        class="w-full bg-slate-800 border border-white/20 rounded-lg px-3 py-2 text-white focus:border-emerald-500 focus:outline-none">
                </div>
                
                <p class="text-xs text-gray-500 mb-2">Her personel için tamamlanan uçuş sayısı:</p>
                <div class="space-y-2 mb-4" id="newStatsFields">
                    ${staffHtml}
                </div>
                
                <button onclick="app.ui.saveNewStatsDay()" 
                    class="w-full py-3 px-4 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-bold rounded-xl transition shadow-lg shadow-emerald-600/20">
                    <i class="fa-solid fa-check mr-2"></i>Kaydet
                </button>
            `;
        },

        // Yeni gün kaydet
        saveNewStatsDay: () => {
            const dateInput = document.getElementById('newStatsDate');
            if (!dateInput || !dateInput.value) {
                app.ui.toast('Tarih seçmelisin', 'error');
                return;
            }

            const dateStr = dateInput.value; // YYYY-MM-DD format
            const staffList = app.state.staff || [];
            const newData = {};

            staffList.forEach(name => {
                const input = document.getElementById('newstat_' + name.replace(/[^a-zA-Z0-9]/g, '_'));
                if (input) {
                    newData[name] = parseInt(input.value) || 0;
                }
            });

            db.collection('statsArchive').doc(dateStr).set(newData)
                .then(() => {
                    app.ui.toast(`${dateStr} kaydedildi!`, 'success');
                    app.ui.showStatsEditor(); // Listeyi yenile
                })
                .catch(err => {
                    console.error('Kaydetme hatası:', err);
                    app.ui.toast('Kaydetme hatası', 'error');
                });
        },

        // Admin kontrolü - düzenleme işlemlerinden önce çağrılır
        requireAdmin: (action) => {
            if (!app.state.isAdmin) {
                app.ui.toast('Bu işlem için admin yetkisi gerekli', 'error');
                return false;
            }
            return true;
        },

        // Eski checkPin uyumluluk için
        checkPin: () => { app.ui.loginAsAdmin(); },
        toast: (msg, type = 'info') => {
            const c = document.getElementById('toastContainer'); const d = document.createElement('div');
            const cls = { success: 'border-emerald-500 bg-emerald-500/20 shadow-emerald-500/10 text-emerald-200', error: 'border-red-500 bg-red-500/20 shadow-red-500/10 text-red-200', info: 'border-blue-500 bg-blue-500/20 shadow-blue-500/10 text-blue-200' };
            d.className = `p-3 rounded-xl border-l-4 backdrop-blur-xl shadow-2xl text-xs font-bold text-white animate-slide-in pointer-events-auto flex items-center gap-3 uppercase tracking-wide ${cls[type] || cls.info}`;
            d.innerHTML = `<span>${msg}</span>`; c.appendChild(d); setTimeout(() => { d.style.opacity = '0'; d.style.transform = 'translateY(-10px)'; setTimeout(() => d.remove(), 300); }, 3000);
        },
        startClock: () => { setInterval(() => { const now = new Date(); document.getElementById('liveClock').innerText = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' }); }, 1000); },
        clearSearch: () => { const el = document.getElementById('searchInput'); const elMob = document.getElementById('searchInputMobile'); if (el) el.value = ''; if (elMob) elMob.value = ''; app.ui.render(); },
        toggleMobileSearch: () => { const el = document.getElementById('mobileSearch'); const wasHidden = el.classList.contains('hidden'); el.classList.toggle('hidden'); if (wasHidden) { setTimeout(() => document.getElementById('searchInputMobile').focus(), 100); } else { app.ui.clearSearch(); } },
        setFilter: (mode) => {
            app.localFilters.filterMode = mode;
            ['all', 'focus', 'completed'].forEach(m => {
                const btn = document.getElementById(`filter-${m}`); if (!btn) return;
                if (m === mode) { btn.className = "px-4 md:px-6 py-1.5 md:py-2 rounded-xl text-[10px] font-bold uppercase transition text-white bg-blue-600 shadow-lg shadow-blue-600/30 border border-blue-500/50 transform scale-105"; }
                else { btn.className = "px-4 md:px-6 py-1.5 md:py-2 rounded-xl text-[10px] font-bold uppercase transition text-gray-400 hover:text-white border border-transparent hover:bg-white/5"; }
            }); app.ui.render();
        },
        toggleMenu: () => { const m = document.getElementById('mainMenu'); if (m) m.classList.toggle('hidden'); },
        closeMenus: (e) => { if (!e.target.closest('button') && !e.target.closest('#mainMenu') && !e.target.closest('#mobileSearch')) { document.getElementById('mainMenu').classList.add('hidden'); } },
        toggleSettings: () => { if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); return; } const m = document.getElementById('staffModal'); if (m) m.classList.toggle('hidden'); },
        toggleAnalysis: () => { const m = document.getElementById('analysisModal'); m.classList.toggle('hidden'); if (!m.classList.contains('hidden')) app.logic.analyze(); },
        confirmReset: () => { app.ui.showResetConfirmModal(); },
        toggleCompleted: () => { app.localFilters.showCompleted = !app.localFilters.showCompleted; app.ui.updateCompletedBtn(); app.ui.render(); },
        updateCompletedBtn: () => { const lbl = document.getElementById('lblCompleted'); if (lbl) lbl.innerText = app.localFilters.showCompleted ? "GİZLE" : "GÖSTER"; },

        // Personel filtreleme modalı (herkes erişebilir)
        showStaffFilterModal: () => {
            const existing = document.getElementById('staffFilterModal');
            if (existing) { existing.remove(); return; }

            const staffList = app.state.staff.map(s => {
                const isActive = app.localFilters.staffFilter === s;
                const count = app.state.completed.filter(fid => app.state.assignments[fid] === s).length;
                return `
                    <button onclick="app.ui.filterByStaff('${s}')" 
                        class="w-full p-3 rounded-xl flex justify-between items-center ${isActive ? 'bg-purple-500/20 border-purple-500/50' : 'bg-white/5 border-white/10'} border hover:bg-white/10 transition group">
                        <span class="flex items-center gap-3">
                            <span class="w-8 h-8 rounded-lg ${isActive ? 'bg-purple-500' : 'bg-purple-500/20'} flex items-center justify-center">
                                <i class="fa-solid fa-user text-xs ${isActive ? 'text-white' : 'text-purple-400'}"></i>
                            </span>
                            <span class="font-bold ${isActive ? 'text-purple-400' : 'text-white'}">${s}</span>
                            ${isActive ? '<i class="fa-solid fa-check text-purple-400 text-xs"></i>' : ''}
                        </span>
                        <span class="text-xs font-bold ${count > 0 ? 'text-emerald-400' : 'text-gray-500'}">${count}</span>
                    </button>`;
            }).join('');

            const modal = document.createElement('div');
            modal.id = 'staffFilterModal';
            modal.className = 'fixed inset-0 bg-black/80 backdrop-blur-sm z-[200] flex items-center justify-center p-4';
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
            modal.innerHTML = `
                <div class="bg-slate-900/95 rounded-2xl border border-white/10 shadow-2xl max-w-sm w-full max-h-[80vh] overflow-hidden">
                    <div class="p-4 border-b border-white/10 flex justify-between items-center bg-gradient-to-r from-purple-500/10 to-purple-600/5">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-xl bg-purple-500/20 border border-purple-500/30 flex items-center justify-center">
                                <i class="fa-solid fa-user-check text-purple-400"></i>
                            </div>
                            <div>
                                <h3 class="font-bold text-white">Personel Filtrele</h3>
                                <p class="text-xs text-gray-400">Bir personelin uçuşlarını görüntüle</p>
                            </div>
                        </div>
                        <button onclick="document.getElementById('staffFilterModal').remove()" class="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-gray-400 hover:text-white transition">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                    <div class="p-4 space-y-2 max-h-[50vh] overflow-y-auto custom-scroll">
                        ${app.localFilters.staffFilter ? `
                            <button onclick="app.ui.clearStaffFilter(); document.getElementById('staffFilterModal').remove();" 
                                class="w-full p-3 rounded-xl bg-gradient-to-r from-blue-500/20 to-blue-600/20 border border-blue-500/30 hover:bg-blue-500/30 transition flex items-center justify-center gap-2 mb-3">
                                <i class="fa-solid fa-filter-circle-xmark text-blue-400"></i>
                                <span class="font-bold text-blue-400">Tümünü Göster</span>
                            </button>
                        ` : ''}
                        ${staffList}
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        },

        // Çakışma uyarı modalı - uzaktan yeni veri tespit edildiğinde gösterilir
        showConflictWarning: (remoteTimestamp) => {
            const existing = document.getElementById('conflictModal');
            if (existing) existing.remove();

            const timeDiff = Math.round((remoteTimestamp - app.state.lastUpdated) / 1000);
            const remoteDate = new Date(remoteTimestamp).toLocaleString('tr-TR');

            const modal = document.createElement('div');
            modal.id = 'conflictModal';
            modal.className = 'fixed inset-0 bg-black/90 backdrop-blur-md z-[300] flex items-center justify-center p-4';
            modal.innerHTML = `
                <div class="bg-slate-900/95 rounded-2xl border border-red-500/30 shadow-2xl max-w-md w-full overflow-hidden animate-pulse-slow">
                    <div class="p-6 border-b border-red-500/20 bg-gradient-to-r from-red-500/10 to-amber-500/10">
                        <div class="flex items-center gap-4">
                            <div class="w-16 h-16 rounded-2xl bg-red-500/20 border-2 border-red-500/50 flex items-center justify-center">
                                <i class="fa-solid fa-triangle-exclamation text-3xl text-red-500 animate-pulse"></i>
                            </div>
                            <div>
                                <h3 class="text-xl font-bold text-red-400">⚠️ Veri Çakışması!</h3>
                                <p class="text-sm text-gray-400 mt-1">Başka bir cihazdan güncelleme yapılmış</p>
                            </div>
                        </div>
                    </div>
                    <div class="p-6">
                        <div class="bg-slate-800/50 rounded-xl p-4 mb-6 border border-white/5">
                            <div class="flex justify-between items-center mb-3">
                                <span class="text-xs text-gray-500">Uzaktaki veri</span>
                                <span class="text-xs font-mono text-red-400">${remoteDate}</span>
                            </div>
                            <div class="flex justify-between items-center">
                                <span class="text-xs text-gray-500">Fark</span>
                                <span class="text-xs font-mono text-amber-400">${timeDiff} saniye daha yeni</span>
                            </div>
                        </div>
                        
                        <div class="space-y-3">
                            <button onclick="app.ui.resolveConflict('refresh')" 
                                class="w-full py-4 px-4 bg-gradient-to-r from-emerald-600 to-emerald-500 hover:from-emerald-500 hover:to-emerald-400 text-white font-bold rounded-xl transition flex items-center justify-center gap-3 shadow-lg shadow-emerald-600/20">
                                <i class="fa-solid fa-cloud-arrow-down text-xl"></i>
                                <div class="text-left">
                                    <div>Verileri Yenile</div>
                                    <div class="text-xs font-normal opacity-80">Uzaktaki güncel veriyi al (Önerilen)</div>
                                </div>
                            </button>
                            <button onclick="app.ui.resolveConflict('overwrite')" 
                                class="w-full py-3 px-4 bg-red-500/20 hover:bg-red-500/30 text-red-400 font-bold rounded-xl transition border border-red-500/30 flex items-center justify-center gap-2">
                                <i class="fa-solid fa-cloud-arrow-up"></i>
                                Üzerine Yaz (Riskli)
                            </button>
                            <button onclick="document.getElementById('conflictModal').remove(); app.canWrite = false;" 
                                class="w-full py-2 px-4 bg-white/5 hover:bg-white/10 text-gray-400 font-medium rounded-xl transition text-sm">
                                Şimdilik Bekle
                            </button>
                        </div>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        },

        // Çakışma çözümleme
        resolveConflict: async (action) => {
            document.getElementById('conflictModal')?.remove();

            if (action === 'refresh') {
                // Firestore'dan güncel veriyi al
                app.ui.toast('Veriler yenileniyor...', 'info');
                try {
                    const docSnap = await db.collection('appState').doc('main').get();
                    const data = docSnap.data();
                    if (data) {
                        app.state = { ...data };
                        app.canWrite = true;
                        app.ui.render();
                        app.ui.renderStaff();
                        app.ui.toast('Veriler güncellendi!', 'success');
                    }
                } catch (err) {
                    console.error('Refresh error:', err);
                    app.ui.toast('Yenileme hatası', 'error');
                }
            } else if (action === 'overwrite') {
                // Üzerine yaz - zorla kaydet
                app.canWrite = true;
                app.state.lastUpdated = Date.now();
                await db.collection('appState').doc('main').set(app.state);
                app.ui.toast('Veriler üzerine yazıldı!', 'success');
            }
        },

        filterByStaff: (staffName) => {
            app.localFilters.staffFilter = staffName;
            app.ui.render();
            app.ui.toast(`${staffName} uçuşları gösteriliyor`, 'info');
            // Modalleri kapat
            const staffModal = document.getElementById('staffModal');
            if (staffModal) staffModal.classList.add('hidden');
            const staffFilterModal = document.getElementById('staffFilterModal');
            if (staffFilterModal) staffFilterModal.remove();
            // Header indicator güncelle
            const indicator = document.getElementById('staffFilterIndicator');
            if (indicator) indicator.classList.remove('hidden');
        },
        clearStaffFilter: () => {
            app.localFilters.staffFilter = null;
            app.ui.render();
            app.ui.toast('Tüm uçuşlar gösteriliyor', 'info');
            // Header indicator gizle
            const indicator = document.getElementById('staffFilterIndicator');
            if (indicator) indicator.classList.add('hidden');
        },

        showShiftConfig: () => {
            document.getElementById('shiftConfigModal').classList.remove('hidden');
            app.ui.selectShiftType(app.state.shift || 'day');
        },

        selectShiftType: (type) => {
            ['day', 'night', 'all'].forEach(t => {
                const btn = document.getElementById(`sc-btn-${t}`);
                if (t === type) { btn.classList.add('active'); btn.classList.remove('bg-white/5', 'text-gray-400'); }
                else { btn.classList.remove('active'); btn.classList.add('bg-white/5', 'text-gray-400'); }
            });
            const startInp = document.getElementById('sc-start'); const endInp = document.getElementById('sc-end');
            if (type === 'day') { startInp.value = "08:00"; endInp.value = "20:00"; }
            else if (type === 'night') { startInp.value = "20:00"; endInp.value = "08:00"; }
            else { startInp.value = "00:00"; endInp.value = "23:59"; }
        },

        // Mobile quick complete - completes first incomplete flight in focus
        quickCompleteAction: () => {
            const now = new Date();
            const focusFlights = app.state.flights.filter(f => {
                const d = new Date(f.timestamp);
                const m = d.getHours() * 60 + d.getMinutes() + (f.isNextDay ? 1440 : 0);
                if (app.state.shift === 'all') return true;
                return (m >= app.state.customStart && m <= app.state.customEnd);
            }).filter(f => !f.isBuffer && !app.state.completed.includes(f.id))
                .sort((a, b) => a.timestamp - b.timestamp);

            if (focusFlights.length === 0) {
                app.ui.toast("Tamamlanacak uçuş yok", "info");
                return;
            }

            // Complete the first one
            const nextFlight = focusFlights[0];
            app.logic.toggleComplete(nextFlight.id);
            app.ui.toast(`${nextFlight.flightNo} tamamlandı`, "success");
        },


        showExcelMergeModal: () => {
            const modal = document.getElementById('excelMergeModal');
            if (modal) modal.classList.remove('hidden');
        },

        updateHeaderShiftLabel: () => {
            const label = document.getElementById('activeShiftLabel'); if (!label) return;
            const s = app.state.shift;
            const minsToTime = (m) => { let h = Math.floor(m / 60); let mn = m % 60; if (h >= 24) h -= 24; return `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}`; };
            let rangeStr = ""; if (s === 'all') rangeStr = "TÜM GÜN"; else { rangeStr = `${minsToTime(app.state.customStart)} - ${minsToTime(app.state.customEnd - (app.state.customEnd > 1440 ? 1440 : 0))}`; }
            const name = s === 'day' ? 'GÜNDÜZ' : (s === 'night' ? 'GECE' : 'TÜMÜ');
            label.innerText = `${name} (${rangeStr})`;
        },

        updateShiftUI: () => {
            // This function is kept for compatibility but main update happens via label now
        },
        showAddFlightModal: () => {
            document.getElementById('addFlightModal').classList.remove('hidden');
            document.getElementById('af-time').value = new Date().toTimeString().slice(0, 5);
            app.ui.selectFlightType('ARR');
        },
        toggleAddFlightModal: () => {
            const modal = document.getElementById('addFlightModal');
            modal.classList.toggle('hidden');
        },
        selectFlightType: (type) => {
            const arrBtn = document.getElementById('af-type-arr');
            const depBtn = document.getElementById('af-type-dep');
            if (type === 'ARR') {
                arrBtn.className = 'py-3 rounded-xl text-xs font-bold uppercase bg-emerald-500 text-white border border-emerald-500/30 transition';
                depBtn.className = 'py-3 rounded-xl text-xs font-bold uppercase bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10 transition';
            } else {
                arrBtn.className = 'py-3 rounded-xl text-xs font-bold uppercase bg-white/5 text-gray-400 border border-white/10 hover:bg-white/10 transition';
                depBtn.className = 'py-3 rounded-xl text-xs font-bold uppercase bg-amber-500 text-white border border-amber-500/30 transition';
            }
        },

        // Uçuş değişiklik geçmişini göster
        showFlightHistory: (id) => {
            const history = app.state.flightHistory[id];
            if (!history || history.length === 0) {
                app.ui.toast("Bu uçuş için geçmiş bulunamadı", "info");
                return;
            }
            const flight = app.state.flights.find(f => f.id === id);
            const flightNo = flight ? flight.flightNo : id;
            const isArr = flight ? flight.type === 'ARR' : true;

            // Geçmiş satırlarını oluştur
            const historyHtml = history.slice().reverse().map((h, i) => {
                const time = new Date(h.timestamp).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
                const icon = h.field === 'Saat' ? 'fa-clock' : 'fa-door-open';
                const color = h.field === 'Saat' ? 'text-cyan-400' : 'text-amber-400';
                return `<div class="flex items-center gap-3 bg-black/20 p-3 rounded-lg border-l-2 ${h.field === 'Saat' ? 'border-cyan-500' : 'border-amber-500'}">
                    <div class="text-xs text-gray-500 font-mono w-12">${time}</div>
                    <i class="fa-solid ${icon} ${color} text-sm"></i>
                    <div class="flex-1">
                        <span class="text-gray-400 text-sm">${h.field}:</span>
                        <span class="text-red-400 line-through text-sm ml-1">${h.oldValue}</span>
                        <span class="text-gray-500 mx-1">→</span>
                        <span class="text-emerald-400 font-bold text-sm">${h.newValue}</span>
                    </div>
                </div>`;
            }).join('');

            // Modal HTML
            const modalHtml = `
            <div id="historyModal" onclick="if(event.target === this) this.remove()" class="fixed inset-0 bg-black/90 backdrop-blur-md z-[110] flex items-center justify-center p-4 animate-fade-in">
                <div class="glass bg-slate-900 rounded-2xl w-full max-w-md shadow-2xl overflow-hidden animate-slide-up border border-white/10">
                    <div class="p-4 border-b border-white/10 flex justify-between items-center bg-gradient-to-r ${isArr ? 'from-emerald-500/10 to-emerald-600/5' : 'from-amber-500/10 to-amber-600/5'}">
                        <div class="flex items-center gap-3">
                            <div class="w-10 h-10 rounded-xl ${isArr ? 'bg-emerald-500/20 border-emerald-500/30' : 'bg-amber-500/20 border-amber-500/30'} border flex items-center justify-center">
                                <i class="fa-solid fa-history ${isArr ? 'text-emerald-400' : 'text-amber-400'}"></i>
                            </div>
                            <div>
                                <h3 class="font-display font-bold text-lg text-white">${flightNo}</h3>
                                <p class="text-xs text-gray-400">Değişiklik Geçmişi</p>
                            </div>
                        </div>
                        <button onclick="document.getElementById('historyModal').remove()" class="w-8 h-8 rounded-full hover:bg-white/10 flex items-center justify-center text-gray-400 hover:text-white transition">
                            <i class="fa-solid fa-times"></i>
                        </button>
                    </div>
                    <div class="p-4 space-y-2 max-h-[60vh] overflow-y-auto custom-scroll">
                        ${historyHtml}
                    </div>
                    <div class="p-3 border-t border-white/10 bg-white/5 text-center">
                        <span class="text-[10px] text-gray-500">Son ${history.length} değişiklik gösteriliyor</span>
                    </div>
                </div>
            </div>`;

            // Mevcut modalı kaldır ve yenisini ekle
            const existingModal = document.getElementById('historyModal');
            if (existingModal) existingModal.remove();
            document.body.insertAdjacentHTML('beforeend', modalHtml);
        },

        smartReset: () => {
            const currentStaff = app.state.staff;
            app.state = {
                flights: [],
                shift: 'day',
                customStart: 480, customEnd: 1200,
                staff: currentStaff,
                assignments: {},
                gates: {},
                overrides: {},
                completed: [],
                delayed: {},
                showCompleted: true,
                filterMode: 'all',
                baseDate: null
            };
            app.data.save(); app.ui.render(); app.ui.renderStaff(); app.ui.updateHeaderShiftLabel();
            app.ui.toast("Sistem Temizlendi", "success");
            document.getElementById('confirmModal').classList.add('hidden');
        },

        // İstatistikleri Firestore'a arşivle
        archiveStats: () => {
            const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
            const counts = {};
            app.state.staff.forEach(s => counts[s] = 0);

            app.state.completed.forEach(fid => {
                const staffName = app.state.assignments[fid];
                if (staffName && counts.hasOwnProperty(staffName)) {
                    counts[staffName]++;
                }
            });

            // Firestore'a kaydet
            if (typeof db !== 'undefined') {
                db.collection('statsArchive').doc(today).set(counts)
                    .then(() => {
                        app.ui.toast("İstatistikler arşivlendi", "success");
                        app.ui.smartReset(); // Arşivledikten sonra sıfırla
                    })
                    .catch(err => {
                        console.error('Arşiv hatası:', err);
                        app.ui.toast("Arşivleme hatası", "error");
                    });
            } else {
                app.ui.toast("Firestore bağlantısı yok", "error");
            }
        },

        // Gelişmiş sıfırlama onay modalı
        showResetConfirmModal: () => {
            app.ui.toggleMenu();

            // Mevcut istatistikleri hesapla
            let totalCompleted = app.state.completed.length;

            // Modal varsa kaldır
            const existing = document.getElementById('resetConfirmModal');
            if (existing) existing.remove();

            const modal = document.createElement('div');
            modal.id = 'resetConfirmModal';
            modal.className = 'fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-4';
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
            modal.innerHTML = `
                <div class="bg-slate-900/95 rounded-2xl border border-white/10 shadow-2xl p-6 max-w-sm w-full">
                    <div class="text-center mb-6">
                        <div class="w-14 h-14 bg-red-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
                            <i class="fa-solid fa-trash text-2xl text-red-500"></i>
                        </div>
                        <h3 class="text-lg font-bold text-white mb-2">Sistemi Sıfırla</h3>
                        <p class="text-sm text-gray-400">Tüm uçuş verileri silinecek</p>
                        ${totalCompleted > 0 ? `<p class="text-xs text-amber-400 mt-2">📊 ${totalCompleted} tamamlanan uçuş var</p>` : ''}
                    </div>
                    <div class="space-y-3">
                        ${totalCompleted > 0 ? `
                        <button onclick="app.ui.archiveStats(); document.getElementById('resetConfirmModal').remove();" 
                            class="w-full py-3 px-4 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-400 font-bold rounded-xl transition flex items-center justify-center gap-2 border border-emerald-500/30">
                            <i class="fa-solid fa-cloud-arrow-up"></i>
                            İstatistikleri Kaydet ve Sıfırla
                        </button>
                        ` : ''}
                        <button onclick="app.ui.smartReset(); document.getElementById('resetConfirmModal').remove();" 
                            class="w-full py-3 px-4 bg-red-500/20 hover:bg-red-500/30 text-red-400 font-bold rounded-xl transition flex items-center justify-center gap-2 border border-red-500/30">
                            <i class="fa-solid fa-trash"></i>
                            ${totalCompleted > 0 ? 'Kaydetmeden Sıfırla' : 'Sistemi Sıfırla'}
                        </button>
                        <button onclick="document.getElementById('resetConfirmModal').remove();" 
                            class="w-full py-2 px-4 bg-white/5 hover:bg-white/10 text-gray-400 font-bold rounded-xl transition">
                            İptal
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        },

        // Uçuş sağ tık context menu
        showFlightContextMenu: (e, flightId) => {
            e.preventDefault();
            if (!app.isAdmin) return;

            // Mevcut context menu'yu kaldır
            const existing = document.getElementById('flightContextMenu');
            if (existing) existing.remove();

            const flight = app.state.flights.find(f => f.id === flightId);
            if (!flight) return;

            const menu = document.createElement('div');
            menu.id = 'flightContextMenu';
            menu.className = 'fixed z-[300] bg-slate-900 border border-white/20 rounded-xl shadow-2xl overflow-hidden min-w-[180px]';
            menu.style.left = e.clientX + 'px';
            menu.style.top = e.clientY + 'px';

            menu.innerHTML = `
                <div class="px-4 py-2 border-b border-white/10 text-xs text-gray-400 font-bold uppercase">
                    ${flight.flightNo}
                </div>
                <button onclick="app.ui.queryFlightLiveInfo('${flightId}')" 
                    class="w-full px-4 py-3 flex items-center gap-3 text-cyan-400 hover:bg-cyan-500/20 transition text-sm font-bold">
                    <i class="fa-solid fa-satellite-dish"></i>
                    Canlı Bilgi Sorgula
                </button>
                <button onclick="app.ui.confirmDeleteFlight('${flightId}')" 
                    class="w-full px-4 py-3 flex items-center gap-3 text-red-400 hover:bg-red-500/20 transition text-sm font-bold">
                    <i class="fa-solid fa-trash"></i>
                    Uçuşu Sil
                </button>
                <button onclick="document.getElementById('flightContextMenu').remove()" 
                    class="w-full px-4 py-3 flex items-center gap-3 text-gray-400 hover:bg-white/10 transition text-sm">
                    <i class="fa-solid fa-times"></i>
                    İptal
                </button>
            `;

            document.body.appendChild(menu);

            // Sayfa tıklamasında kapat
            const closeMenu = (ev) => {
                if (!menu.contains(ev.target)) {
                    menu.remove();
                    document.removeEventListener('click', closeMenu);
                }
            };
            setTimeout(() => document.addEventListener('click', closeMenu), 100);
        },

        // Uçuş canlı bilgi sorgulama (AirLabs API)
        queryFlightLiveInfo: async (flightId) => {
            const menu = document.getElementById('flightContextMenu');
            if (menu) menu.remove();

            const flight = app.state.flights.find(f => f.id === flightId);
            if (!flight) return;

            app.ui.toast('Canlı bilgi sorgulanıyor...', 'info');

            // Tam uçuş numarası oluştur (airline kodu + sayı)
            const fullFlightNo = (flight.airline + flight.flightNo).replace(/\s/g, '').toUpperCase();
            console.log('🔍 AirLabs sorgusu:', fullFlightNo);

            // Cache'de varsa hemen göster, yoksa API'den çek
            let liveInfo = airLabs.getFlightInfo(fullFlightNo);

            if (!liveInfo && Object.keys(airLabs.flightCache).length === 0) {
                // Cache boş, API'den çek
                await airLabs.fetchSchedules();
                liveInfo = airLabs.getFlightInfo(fullFlightNo);
            }

            // Modal oluştur
            const modal = document.createElement('div');
            modal.id = 'liveInfoModal';
            modal.className = 'fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-4';
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

            if (liveInfo) {
                const delayBadge = liveInfo.delayMinutes > 0
                    ? `<span class="px-3 py-1 rounded-full bg-red-500/30 text-red-400 text-sm font-bold">+${liveInfo.delayMinutes} DK GECİKME</span>`
                    : `<span class="px-3 py-1 rounded-full bg-green-500/30 text-green-400 text-sm font-bold">ZAMANINDA</span>`;

                const statusBadge = {
                    'scheduled': '<span class="text-yellow-400">📅 Planlandı</span>',
                    'en-route': '<span class="text-cyan-400">✈️ Havada</span>',
                    'landed': '<span class="text-green-400">✅ İndi</span>',
                    'cancelled': '<span class="text-red-400">❌ İptal</span>'
                }[liveInfo.status] || `<span class="text-gray-400">${liveInfo.status}</span>`;

                modal.innerHTML = `
                    <div class="bg-slate-900/95 rounded-2xl border border-white/20 max-w-md w-full p-6 space-y-4">
                        <div class="flex items-center justify-between">
                            <h3 class="text-xl font-bold text-white">${liveInfo.flightNumber}</h3>
                            <button onclick="document.getElementById('liveInfoModal').remove()" class="text-gray-400 hover:text-white text-2xl">&times;</button>
                        </div>
                        <div class="text-center py-4">
                            ${delayBadge}
                        </div>
                        <div class="grid grid-cols-2 gap-4 text-sm">
                            <div class="bg-white/5 rounded-lg p-3">
                                <div class="text-gray-400">Kalkış</div>
                                <div class="text-white font-bold">${liveInfo.depAirport || '-'}</div>
                            </div>
                            <div class="bg-white/5 rounded-lg p-3">
                                <div class="text-gray-400">Varış</div>
                                <div class="text-white font-bold">${liveInfo.arrAirport || '-'}</div>
                            </div>
                            <div class="bg-white/5 rounded-lg p-3">
                                <div class="text-gray-400">Planlı Varış</div>
                                <div class="text-white font-bold">${liveInfo.scheduledArr || '-'}</div>
                            </div>
                            <div class="bg-white/5 rounded-lg p-3">
                                <div class="text-gray-400">Tahmini Varış</div>
                                <div class="text-white font-bold">${liveInfo.estimatedArr || '-'}</div>
                            </div>
                        </div>
                        <div class="text-center py-2">
                            ${statusBadge}
                        </div>
                        <div class="text-xs text-center text-gray-500">
                            Son güncelleme: ${new Date(airLabs.lastFetch).toLocaleTimeString('tr-TR')}
                        </div>
                    </div>
                `;
            } else {
                modal.innerHTML = `
                    <div class="bg-slate-900/95 rounded-2xl border border-white/20 max-w-md w-full p-6 text-center">
                        <div class="text-6xl mb-4">❓</div>
                        <h3 class="text-xl font-bold text-white mb-2">${flight.flightNo}</h3>
                        <p class="text-gray-400 mb-4">Bu uçuş için canlı bilgi bulunamadı.</p>
                        <p class="text-xs text-gray-500 mb-4">Uçuş henüz başlamamış veya API'de kayıtlı değil olabilir.</p>
                        <button onclick="document.getElementById('liveInfoModal').remove()" 
                            class="px-6 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-white">
                            Kapat
                        </button>
                    </div>
                `;
            }

            document.body.appendChild(modal);

            // Bireysel sorgulama sonrası kartları yenile (etiketler görünsün)
            if (liveInfo) {
                app.ui.render();
            }
        },

        // Canlı bilgi popup'ı (cache'den - kullanıcı için)
        showLiveInfoPopup: (flightId) => {
            const flight = app.state.flights.find(f => f.id === flightId);
            if (!flight) return;

            const fullFlightNo = (flight.airline + flight.flightNo).replace(/\s/g, '').toUpperCase();
            const liveInfo = airLabs.getFlightInfo(fullFlightNo);

            const modal = document.createElement('div');
            modal.id = 'liveInfoPopup';
            modal.className = 'fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-4';
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

            if (liveInfo) {
                // Uçuş tipini belirle (ARR = varış, DEP = kalkış)
                const isArr = flight.type === 'ARR';
                const relevantDelay = isArr ? liveInfo.arrDelayMinutes : liveInfo.depDelayMinutes;
                const scheduledTime = isArr ? liveInfo.scheduledArr : liveInfo.scheduledDep;
                const estimatedTime = isArr ? liveInfo.estimatedArr : liveInfo.estimatedDep;
                const timeLabel = isArr ? 'Varış' : 'Kalkış';

                const delayBadge = relevantDelay > 0
                    ? `<span class="px-3 py-1 rounded-full bg-red-500/30 text-red-400 text-sm font-bold">+${relevantDelay} DK GECİKME</span>`
                    : `<span class="px-3 py-1 rounded-full bg-green-500/30 text-green-400 text-sm font-bold">ZAMANINDA</span>`;

                const statusBadge = {
                    'scheduled': '<span class="text-yellow-400">📅 Planlandı</span>',
                    'en-route': '<span class="text-cyan-400">✈️ Havada</span>',
                    'landed': '<span class="text-green-400">✅ İndi</span>',
                    'cancelled': '<span class="text-red-400">❌ İptal</span>'
                }[liveInfo.status] || `<span class="text-gray-400">${liveInfo.status}</span>`;

                modal.innerHTML = `
                    <div class="bg-slate-900/95 rounded-2xl border border-white/20 max-w-md w-full p-6 space-y-4">
                        <div class="flex items-center justify-between">
                            <h3 class="text-xl font-bold text-white"><i class="fa-solid fa-satellite-dish text-cyan-400 mr-2"></i>${liveInfo.flightNumber} <span class="text-xs ${isArr ? 'text-emerald-400' : 'text-amber-400'}">${isArr ? 'İNİŞ' : 'KALKIŞ'}</span></h3>
                            <button onclick="document.getElementById('liveInfoPopup').remove()" class="text-gray-400 hover:text-white text-2xl">&times;</button>
                        </div>
                        <div class="text-center py-4">
                            ${delayBadge}
                        </div>
                        <div class="grid grid-cols-2 gap-4 text-sm">
                            <div class="bg-white/5 rounded-lg p-3">
                                <div class="text-gray-400">Kalkış</div>
                                <div class="text-white font-bold">${liveInfo.depAirport || '-'}</div>
                            </div>
                            <div class="bg-white/5 rounded-lg p-3">
                                <div class="text-gray-400">Varış</div>
                                <div class="text-white font-bold">${liveInfo.arrAirport || '-'}</div>
                            </div>
                            <div class="bg-white/5 rounded-lg p-3 ${!isArr ? 'border border-amber-500/50' : ''}">
                                <div class="text-gray-400">Planlı ${timeLabel}</div>
                                <div class="text-white font-bold">${scheduledTime || '-'}</div>
                            </div>
                            <div class="bg-white/5 rounded-lg p-3 ${!isArr ? 'border border-amber-500/50' : ''}">
                                <div class="text-gray-400">Tahmini ${timeLabel}</div>
                                <div class="text-white font-bold">${estimatedTime || '-'}</div>
                            </div>
                        </div>
                        <div class="text-center py-2">
                            ${statusBadge}
                        </div>
                        <div class="text-xs text-center text-gray-500">
                            Son güncelleme: ${airLabs.lastFetch ? new Date(airLabs.lastFetch).toLocaleTimeString('tr-TR') : 'Bilinmiyor'}
                        </div>
                    </div>
                `;
            } else {
                modal.innerHTML = `
                    <div class="bg-slate-900/95 rounded-2xl border border-white/20 max-w-md w-full p-6 text-center">
                        <div class="text-6xl mb-4">📡</div>
                        <h3 class="text-xl font-bold text-white mb-2">${fullFlightNo}</h3>
                        <p class="text-gray-400 mb-4">Canlı bilgi henüz yüklenmedi.</p>
                        <p class="text-xs text-gray-500 mb-4">Admin "Canlı Güncelle" yapmalı.</p>
                        <button onclick="document.getElementById('liveInfoPopup').remove()" 
                            class="px-6 py-2 bg-white/10 hover:bg-white/20 rounded-lg text-white">
                            Kapat
                        </button>
                    </div>
                `;
            }

            document.body.appendChild(modal);
        },

        // Uçuş silme onay modalı
        confirmDeleteFlight: (flightId) => {
            const menu = document.getElementById('flightContextMenu');
            if (menu) menu.remove();

            const flight = app.state.flights.find(f => f.id === flightId);
            if (!flight) return;

            const modal = document.createElement('div');
            modal.id = 'deleteFlightModal';
            modal.className = 'fixed inset-0 bg-black/90 backdrop-blur-md z-[200] flex items-center justify-center p-4';
            modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
            modal.innerHTML = `
                <div class="bg-slate-900/95 rounded-2xl border border-red-500/30 shadow-2xl p-6 max-w-sm w-full">
                    <div class="text-center mb-6">
                        <div class="w-14 h-14 bg-red-500/20 rounded-2xl flex items-center justify-center mx-auto mb-4">
                            <i class="fa-solid fa-trash text-2xl text-red-500"></i>
                        </div>
                        <h3 class="text-lg font-bold text-white mb-2">Uçuşu Sil</h3>
                        <p class="text-sm text-gray-400">Bu uçuş tamamen silinecek:</p>
                        <p class="text-lg font-bold text-white mt-2">${flight.flightNo} - ${flight.timeStr}</p>
                    </div>
                    <div class="bg-amber-500/10 border border-amber-500/20 rounded-xl p-3 mb-4">
                        <p class="text-xs text-amber-400 text-center">
                            <i class="fa-solid fa-info-circle mr-1"></i>
                            Ctrl+Z ile geri alabilirsiniz
                        </p>
                    </div>
                    <div class="space-y-3">
                        <button onclick="app.ui.deleteFlight('${flightId}'); document.getElementById('deleteFlightModal').remove();" 
                            class="w-full py-3 px-4 bg-red-500 hover:bg-red-600 text-white font-bold rounded-xl transition flex items-center justify-center gap-2">
                            <i class="fa-solid fa-trash"></i>
                            Evet, Sil
                        </button>
                        <button onclick="document.getElementById('deleteFlightModal').remove();" 
                            class="w-full py-2 px-4 bg-white/5 hover:bg-white/10 text-gray-400 font-bold rounded-xl transition">
                            İptal
                        </button>
                    </div>
                </div>
            `;
            document.body.appendChild(modal);
        },

        // Uçuşu sil
        deleteFlight: (flightId) => {
            if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); return; }

            const flight = app.state.flights.find(f => f.id === flightId);
            if (!flight) { app.ui.toast('Uçuş bulunamadı', 'error'); return; }

            app.logic.pushHistory();

            // Flights'tan kaldır
            app.state.flights = app.state.flights.filter(f => f.id !== flightId);

            // İlişkili verileri temizle
            delete app.state.assignments[flightId];
            delete app.state.gates[flightId];
            delete app.state.overrides[flightId];
            delete app.state.delayed[flightId];
            if (app.state.timeChanges) delete app.state.timeChanges[flightId];
            if (app.state.flightHistory) delete app.state.flightHistory[flightId];
            app.state.completed = app.state.completed.filter(id => id !== flightId);

            app.data.save();
            app.ui.render();
            app.ui.renderStaff();
            app.ui.toast(`${flight.flightNo} silindi`, 'success');
        },


        render: () => {
            const grid = document.getElementById('flightGrid'); if (!grid) return;
            const elSearch = document.getElementById('searchInput'); const term = elSearch ? elSearch.value.toLowerCase().replace(/\s+/g, '') : '';
            const flights = app.state.flights;
            const emptyState = document.getElementById('emptyState');
            if (flights.length === 0) { if (emptyState) emptyState.classList.remove('hidden'); grid.innerHTML = ''; return; } else { if (emptyState) emptyState.classList.add('hidden'); }
            const sorted = [...flights].sort((a, b) => a.timestamp - b.timestamp);
            let counts = { total: flights.length, focus: 0, done: app.state.completed.length, assigned: 0 };

            // Admin kontrolü - kullanıcı modunda inputlar disabled olacak
            const isAdmin = app.isAdmin;
            const disabledAttr = isAdmin ? '' : 'disabled';
            const adminOnlyClass = isAdmin ? '' : 'pointer-events-none opacity-50';

            // DocumentFragment ile batch DOM insertion (MOBİL PERFORMANS)
            const fragment = document.createDocumentFragment();

            sorted.forEach((f, idx) => {
                const searchStr = (f.flightNo + f.airline + f.gate + f.route + f.type + f.rawAirline + f.flightNoOnly).toLowerCase().replace(/\s+/g, '');
                let match = searchStr.includes(term);
                if (!match && term.length > 0) { const aliases = f.rawAirline.split('/').map(x => x.trim().toLowerCase()); match = aliases.some(a => (a + f.flightNoOnly).includes(term)); }
                if (term && !match) return;
                const isDone = app.state.completed.includes(f.id);

                let inFocus = false;
                if (app.state.overrides[f.id] === 'focus') inFocus = true;
                else if (app.state.overrides[f.id] !== 'hide') {
                    const date = new Date(f.timestamp);
                    const m = date.getHours() * 60 + date.getMinutes() + (f.isNextDay ? 1440 : 0);

                    if (app.state.shift === 'all') { inFocus = true; }
                    else { if (m >= app.state.customStart && m <= app.state.customEnd) inFocus = true; }
                }

                if (app.localFilters.filterMode === 'focus' && !inFocus) return; if (app.localFilters.filterMode === 'completed' && !isDone) return; if (isDone && !app.localFilters.showCompleted && app.localFilters.filterMode !== 'completed') return;
                // Güncellenmiş filtresi
                if (app.localFilters.showUpdatedOnly && !f.wasUpdated && !f.gateUpdated && !(app.state.timeChanges && app.state.timeChanges[f.id])) return;
                // Personel filtresi
                if (app.localFilters.staffFilter && app.state.assignments[f.id] !== app.localFilters.staffFilter) return;
                if (inFocus && !isDone) counts.focus++; if (app.state.assignments[f.id]) counts.assigned++;
                const originalGate = f.originalGate || ""; const savedGate = app.state.gates[f.id] !== undefined ? app.state.gates[f.id] : originalGate; const savedStaff = app.state.assignments[f.id] || ''; const isGateChanged = String(savedGate).trim() !== String(originalGate).trim();
                const isTimeChanged = app.state.timeChanges && app.state.timeChanges[f.id] !== undefined;
                const isArr = f.type === 'ARR'; const typeClass = isArr ? 'card-arr' : 'card-dep'; const icon = isArr ? 'fa-plane-arrival' : 'fa-plane-departure'; const label = isArr ? 'GELİŞ' : 'GİDİŞ'; const iconColor = isArr ? 'text-emerald-400' : 'text-amber-400';
                // Format flight number: airline code left, flight number right (PC | 3094)
                const flightLetters = (f.flightNo.replace(/[0-9]/g, '').trim() || f.airline.split('/')[0].trim()).toUpperCase();
                const flightNumbers = f.flightNo.replace(/[^0-9]/g, '').trim() || f.flightNo;
                const dateObj = new Date(f.timestamp); const dateLabel = dateObj.toLocaleDateString('tr-TR', { day: 'numeric', month: 'short' });

                // Delay Logic
                const isDelayed = app.state.delayed[f.id];
                const delayClass = isDelayed ? 'is-delayed' : '';
                const delayBadge = isDelayed ? `<div class="absolute top-0 right-0 bg-red-600 text-white text-[9px] font-bold px-2 py-0.5 rounded-bl-lg z-20 animate-pulse">GECİKME</div>` : '';

                // AirLabs Canlı Bilgi - API'den gelen delay/erken
                const fullFlightNo = (f.airline + f.flightNo).replace(/\s/g, '').toUpperCase();
                const liveInfo = airLabs.getFlightInfo(fullFlightNo);
                let apiDelayBadge = '';
                let liveInfoIcon = '';

                if (liveInfo) {
                    // Uçuş tipine göre doğru delay'i seç (ARR=varış, DEP=kalkış)
                    const relevantDelay = isArr ? liveInfo.arrDelayMinutes : liveInfo.depDelayMinutes;

                    if (relevantDelay > 0) {
                        // Gecikme (turuncu)
                        apiDelayBadge = `<div class="absolute bottom-0 right-0 bg-orange-600 text-white text-[10px] font-bold px-2 py-1 rounded-tl-lg z-20 flex items-center gap-1"><i class="fa-solid fa-clock"></i> +${relevantDelay} DK</div>`;
                    } else if (relevantDelay < 0) {
                        // Erken gelme (yeşil)
                        apiDelayBadge = `<div class="absolute bottom-0 right-0 bg-green-600 text-white text-[10px] font-bold px-2 py-1 rounded-tl-lg z-20 flex items-center gap-1"><i class="fa-solid fa-forward"></i> ${relevantDelay} DK</div>`;
                    }
                    // Canlı bilgi ikonu
                    liveInfoIcon = `<button onclick="event.stopPropagation(); app.ui.showLiveInfoPopup('${f.id}')" class="w-6 h-6 rounded-full bg-cyan-500/30 hover:bg-cyan-500/50 text-cyan-400 flex items-center justify-center border border-cyan-500/40 ml-1" title="Canlı Bilgi"><i class="fa-solid fa-satellite-dish text-[9px]"></i></button>`;
                }

                // Time Changed Class
                const timeChangedClass = isTimeChanged ? 'time-changed' : '';

                // Yeni/Güncellenen Badge'leri
                let updateBadge = '';
                const gateChangedClass = (f.gateUpdated || isGateChanged) ? 'gate-changed' : '';
                if (isTimeChanged) {
                    updateBadge = `<div class="absolute top-0 left-0 bg-cyan-500 text-white text-[10px] font-bold px-3 py-1 rounded-br-xl z-20 flex items-center gap-1.5 animate-pulse shadow-lg"><i class="fa-solid fa-clock"></i> SAAT GÜNCELLENDİ</div>`;
                } else if (f.gateUpdated || (f.wasUpdated && isGateChanged)) {
                    updateBadge = `<div class="absolute top-0 left-0 bg-amber-500 text-white text-[10px] font-bold px-3 py-1 rounded-br-xl z-20 flex items-center gap-1.5 animate-pulse shadow-lg"><i class="fa-solid fa-door-open"></i> KAPI GÜNCELLENDİ</div>`;
                } else if (f.wasUpdated) {
                    updateBadge = `<div class="absolute top-0 left-0 bg-green-500 text-white text-[10px] font-bold px-3 py-1 rounded-br-xl z-20 flex items-center gap-1.5 animate-pulse shadow-lg"><i class="fa-solid fa-plus"></i> YENİ EKLENEN</div>`;
                }

                const el = document.createElement('div');
                el.className = `flight-card rounded-2xl flex flex-col md:flex-row min-h-auto md:min-h-[110px] ${typeClass} ${inFocus && !isDone ? 'in-focus' : 'is-dimmed'} ${isDone ? 'is-completed' : ''} ${delayClass} ${timeChangedClass} ${gateChangedClass} mb-3 md:mb-4 relative overflow-hidden shadow-lg`;
                const completedOverlay = isDone ? `<div class="absolute right-4 top-3 z-50 pointer-events-none transform -rotate-6 opacity-70"><div class="border-2 border-emerald-500/50 text-emerald-400 font-display font-bold text-xs px-3 py-1 rounded-lg uppercase tracking-widest backdrop-blur-sm bg-emerald-500/10">✓ TAMAMLANDI</div></div>` : '';
                el.innerHTML = `${completedOverlay}${delayBadge}${updateBadge}${apiDelayBadge}
                <div class="w-full md:w-36 bg-gradient-to-br from-black/30 to-black/10 flex flex-row md:flex-col items-center justify-between p-3 border-b md:border-b-0 md:border-r border-white/10">
                    <div class="flex items-center gap-3 md:hidden w-full">
                        <div class="w-14 h-14 rounded-xl bg-gradient-to-br ${isArr ? 'from-emerald-500/30 to-emerald-600/20' : 'from-amber-500/30 to-amber-600/20'} flex items-center justify-center border-2 ${isArr ? 'border-emerald-500/50' : 'border-amber-500/50'}"><i class="fa-solid ${icon} ${iconColor} text-3xl"></i></div>
                        <div class="flex-1 flex flex-col gap-1">
                            <input type="text" value="${f.timeStr}" data-original="${f.timeStr}" maxlength="5" onfocus="app.ui.handleTimeInputFocus(this)" oninput="app.ui.handleTimeInputChange(this)" onblur="app.ui.handleTimeInputBlur(this, '${f.id}')" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}" class="w-full text-xl font-mono font-bold text-white bg-black/30 border ${timeChangedClass ? 'border-blue-500 border-2' : 'border-white/10'} rounded-lg px-2 py-1.5 text-center focus:border-blue-500 outline-none ${timeChangedClass} ${adminOnlyClass}" ${disabledAttr}>
                            <div class="text-sm font-extrabold ${isArr ? 'text-emerald-400 bg-emerald-500/20 border-emerald-500/30' : 'text-amber-400 bg-amber-500/20 border-amber-500/30'} px-2 py-1 rounded-lg uppercase text-center border">${isArr ? '✈ İNİŞ' : '✈ KALKIŞ'}</div>
                        </div>
                        ${(app.state.flightHistory && app.state.flightHistory[f.id] && app.state.flightHistory[f.id].length > 0) ? `<button onclick="app.ui.showFlightHistory('${f.id}')" class="w-8 h-8 rounded-full bg-blue-500/20 hover:bg-blue-500/30 text-blue-400 flex items-center justify-center border border-blue-500/30" title="Değişiklik Geçmişi"><i class="fa-solid fa-history text-xs"></i></button>` : ''}
                    </div>
                    <div class="hidden md:flex md:flex-col md:items-center md:text-center w-full gap-1">
                        <div class="w-14 h-14 rounded-xl bg-gradient-to-br ${isArr ? 'from-emerald-500/30 to-emerald-600/20' : 'from-amber-500/30 to-amber-600/20'} flex items-center justify-center border-2 ${isArr ? 'border-emerald-500/50' : 'border-amber-500/50'}"><i class="fa-solid ${icon} ${iconColor} text-2xl"></i></div>
                        <input type="text" value="${f.timeStr}" data-original="${f.timeStr}" maxlength="5" onfocus="app.ui.handleTimeInputFocus(this)" oninput="app.ui.handleTimeInputChange(this)" onblur="app.ui.handleTimeInputBlur(this, '${f.id}')" onkeydown="if(event.key==='Enter'){event.preventDefault();this.blur();}" class="w-full text-lg font-mono font-bold text-white bg-black/30 border ${timeChangedClass ? 'border-blue-500 border-2' : 'border-white/10'} rounded-lg px-1 py-1 text-center focus:border-blue-500 outline-none ${timeChangedClass} ${adminOnlyClass}" ${disabledAttr}>
                        <span class="text-[8px] font-bold text-indigo-400 bg-indigo-500/10 px-1.5 py-0.5 rounded">${dateLabel}</span>
                        <div class="text-xs font-extrabold ${isArr ? 'text-emerald-400 bg-emerald-500/20 border-emerald-500/30' : 'text-amber-400 bg-amber-500/20 border-amber-500/30'} px-2 py-0.5 rounded-md uppercase border">${isArr ? 'İNİŞ' : 'KALKIŞ'}</div>
                    </div>
                </div>
                <div class="flex-1 p-3 md:p-4 flex flex-col justify-center">
                    <div class="flex items-center gap-2 mb-1">
                        <span class="text-xl md:text-2xl font-display font-extrabold text-blue-400 tracking-wide">${flightLetters}</span>
                        <span class="text-2xl md:text-3xl font-display font-bold text-white tracking-tight">${flightNumbers}</span>
                        ${(app.state.flightHistory && app.state.flightHistory[f.id] && app.state.flightHistory[f.id].length > 0) ? `<button onclick="event.stopPropagation(); app.ui.showFlightHistory('${f.id}')" class="w-6 h-6 rounded-full bg-blue-500/30 hover:bg-blue-500/50 text-blue-400 flex items-center justify-center border border-blue-500/40" title="Değişiklik Geçmişi (${app.state.flightHistory[f.id].length})"><i class="fa-solid fa-history text-[9px]"></i></button>` : ''}${liveInfoIcon}
                    </div>
                    <div class="flex items-center gap-2 text-sm">
                        <i class="fa-solid fa-route text-[10px] text-blue-400"></i>
                        <span class="text-gray-300 font-medium">${f.route}</span>
                    </div>
                </div>
                <div class="w-full md:w-56 p-3 md:p-4 flex flex-col justify-center gap-2 bg-gradient-to-br from-black/20 to-transparent border-t md:border-t-0 md:border-l border-white/10">
                    <div class="flex gap-2">
                        <div class="gate-input-wrapper rounded-lg p-1 bg-black/30 border ${isGateChanged ? 'border-amber-500 gate-changed' : 'border-white/10'}">
                            <label class="block text-[7px] text-gray-500 font-bold uppercase text-center tracking-wider">KAPI</label>
                            <input type="text" value="${savedGate}" onchange="app.logic.updateGate('${f.id}', this.value)" class="ghost text-center font-mono font-extrabold text-3xl text-white tracking-widest h-9 w-16 ${adminOnlyClass}" placeholder="---" ${disabledAttr}>
                        </div>
                        <div class="flex flex-col gap-1">
                            <button onclick="app.logic.toggleOverride('${f.id}', '${inFocus ? 'hide' : 'focus'}')" class="w-9 h-8 rounded-lg bg-white/10 hover:bg-white/20 text-gray-400 hover:text-white transition flex items-center justify-center ${adminOnlyClass}" title="${inFocus ? 'Gizle' : 'Odakla'}" ${disabledAttr}><i class="fa-solid ${inFocus ? 'fa-eye-slash' : 'fa-thumbtack'} text-[10px]"></i></button>
                            <button onclick="app.logic.toggleDelay('${f.id}')" class="w-9 h-8 rounded-lg ${isDelayed ? 'bg-red-500 text-white' : 'bg-white/5 text-gray-500 hover:text-red-400'} transition flex items-center justify-center ${adminOnlyClass}" title="Gecikme" ${disabledAttr}><i class="fa-solid fa-clock text-[10px]"></i></button>
                            <button onclick="app.logic.toggleComplete('${f.id}')" class="w-9 h-8 rounded-lg ${isDone ? 'bg-slate-600 text-white' : 'bg-emerald-500/20 hover:bg-emerald-600 text-emerald-400 hover:text-white'} transition flex items-center justify-center ${adminOnlyClass}" title="${isDone ? 'Geri Al' : 'Tamamla'}" ${disabledAttr}><i class="fa-solid ${isDone ? 'fa-rotate-left' : 'fa-check'} text-[10px]"></i></button>
                        </div>
                    </div>
                    <div class="relative">
                        <i class="fa-solid fa-user text-[10px] text-gray-500 absolute left-3 top-1/2 -translate-y-1/2"></i>
                        <input list="staffOptions" value="${savedStaff}" onchange="app.logic.assignStaff('${f.id}', this.value)" placeholder="Personel..." class="w-full bg-black/20 hover:bg-black/30 focus:bg-blue-500/10 border border-white/10 focus:border-blue-500/50 rounded-lg text-xs font-bold text-white py-2 pl-8 pr-2 outline-none transition uppercase placeholder-gray-600 ${adminOnlyClass}" ${disabledAttr}>
                    </div>
                </div>
            `;
                // Sağ tık için context menu event'i ekle (Admin için)
                el.oncontextmenu = (e) => app.ui.showFlightContextMenu(e, f.id);
                fragment.appendChild(el);
            });
            grid.innerHTML = '';
            grid.appendChild(fragment);
            document.getElementById('statTotal').innerText = sorted.length; document.getElementById('statFocus').innerText = counts.focus; document.getElementById('statDone').innerText = counts.done; document.getElementById('statAssigned').innerText = counts.assigned;
            // Personel filtre indicator'larını güncelle (hem desktop hem mobil)
            const indicator = document.getElementById('staffFilterIndicator');
            const mobileIndicator = document.getElementById('mobileStaffFilterIndicator');
            if (indicator) {
                if (app.localFilters.staffFilter) indicator.classList.remove('hidden');
                else indicator.classList.add('hidden');
            }
            if (mobileIndicator) {
                if (app.localFilters.staffFilter) mobileIndicator.classList.remove('hidden');
                else mobileIndicator.classList.add('hidden');
            }
        },
        renderStaff: () => {
            const counts = {}; app.state.staff.forEach(s => counts[s] = 0); app.state.completed.forEach(fid => { const s = app.state.assignments[fid]; if (s && counts.hasOwnProperty(s)) counts[s]++; });
            document.getElementById('staffOptions').innerHTML = app.state.staff.map(s => `<option value="${s}">`).join('');

            // Aktif filtre gösterimi
            const filterHeader = app.localFilters.staffFilter ? `
                <div class="mb-3 p-2 bg-blue-500/20 rounded-lg border border-blue-500/30 flex justify-between items-center">
                    <span class="text-xs font-bold text-blue-400"><i class="fa-solid fa-filter mr-2"></i>Filtre: ${app.localFilters.staffFilter}</span>
                    <button onclick="app.ui.clearStaffFilter()" class="text-xs font-bold text-white bg-blue-500 hover:bg-blue-600 px-2 py-1 rounded transition">Tümünü Göster</button>
                </div>
            ` : '';

            document.getElementById('staffList').innerHTML = filterHeader + app.state.staff.map(s => {
                const isActive = app.localFilters.staffFilter === s;
                return `
                <div class="flex justify-between items-center ${isActive ? 'bg-blue-500/20 border-blue-500/30' : 'bg-white/5 border-white/5'} p-2 rounded-lg border group hover:border-white/20 transition hover:bg-white/10 duration-200 cursor-pointer" onclick="app.ui.filterByStaff('${s}')">
                    <span class="text-xs font-bold text-gray-300 uppercase tracking-wide flex items-center gap-3">
                        <span class="w-6 h-6 rounded ${isActive ? 'bg-blue-500' : 'bg-blue-500/10'} flex items-center justify-center text-${isActive ? 'white' : 'blue-400'}">
                            <i class="fa-solid fa-user-astronaut text-[10px]"></i>
                        </span>
                        ${s}
                        ${isActive ? '<i class="fa-solid fa-check text-blue-400 text-[10px]"></i>' : ''}
                    </span>
                    <div class="flex items-center gap-2">
                        <span class="text-[10px] font-bold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">${counts[s] || 0}</span>
                        <button onclick="event.stopPropagation(); app.logic.removeStaff('${s}')" class="admin-only text-gray-500 hover:text-red-400 p-1.5"><i class="fa-solid fa-trash text-xs"></i></button>
                    </div>
                </div>`;
            }).join('');
        }
    },
    logic: {
        pendingExcelData: null, // Bekleyen Excel verisi
        handleFileUpload: (e) => {
            if (!app.isAdmin) { app.ui.toast('Bu işlem için admin yetkisi gerekli', 'error'); e.target.value = ''; return; }
            const file = e.target.files[0]; if (!file) return;
            const r = new FileReader();
            r.onload = (evt) => {
                const wb = XLSX.read(new Uint8Array(evt.target.result), { type: 'array' });
                const ws = wb.Sheets[wb.SheetNames[0]];
                const json = XLSX.utils.sheet_to_json(ws, { header: 1 });
                // Mevcut veri var mı kontrol et
                if (app.state.flights.length > 0) {
                    app.logic.pendingExcelData = json;
                    app.ui.showExcelMergeModal();
                } else {
                    app.logic.parse(json);
                }
            };
            r.readAsArrayBuffer(file); e.target.value = '';
        },
        mergeExcelData: () => {
            if (!app.logic.pendingExcelData) return;
            const rows = app.logic.pendingExcelData;
            let hIdx = -1, dateStr = "";
            for (let i = 0; i < Math.min(rows.length, 25); i++) { if (!rows[i]) continue; const s = rows[i].join(" ").toUpperCase(); if (s.match(/(\d{2}\.\d{2}\.\d{4})/)) dateStr = s.match(/(\d{2}\.\d{2}\.\d{4})/)[1]; if (s.includes("FLIGHT NO") && s.includes("AIRLINE")) { hIdx = i; break; } }
            if (hIdx === -1) { app.ui.toast("Header Bulunamadı!", "error"); app.logic.pendingExcelData = null; return; }
            const header = rows[hIdx].map(x => String(x).toUpperCase().trim());
            const m = { airline: -1, gate: -1, route: -1, arrNo: -1, arrTime: -1, depNo: -1, depTime: -1 };
            header.forEach((c, i) => { if (c.includes("AIRLINE")) m.airline = i; if (c.includes("BRIDGE") || c.includes("GATE")) m.gate = i; if (c.includes("STATIONS") || c.includes("ROUTE")) m.route = i; });
            const split = Math.floor(header.length / 2);
            header.forEach((c, i) => { if (i < split) { if (c.includes("FLIGHT") || c.includes("NO")) m.arrNo = i; if (c.includes("STA") || c.includes("TIME")) m.arrTime = i; } else { if ((c.includes("FLIGHT") || c.includes("NO")) && m.depNo === -1) m.depNo = i; if ((c.includes("STD") || c.includes("TIME")) && m.depTime === -1) m.depTime = i; } });
            const toMins = (v) => { if (typeof v === 'number') return Math.round(v * 1440); if (typeof v === 'string' && v.includes(':')) { const [h, mn] = v.split(':').map(Number); return h * 60 + mn; } return null; };
            const data = rows.slice(hIdx + 1);
            let stats = { updated: 0, added: 0, unchanged: 0 };
            data.forEach((row, idx) => {
                if (!row || !row[m.arrNo] && !row[m.depNo]) return;
                const air = row[m.airline] || ""; const gate = row[m.gate] || "";
                // ARR uçuşunu kontrol et
                if (row[m.arrNo] && row[m.arrTime]) {
                    const tm = toMins(row[m.arrTime]); if (tm === null) return;
                    const h = Math.floor(tm / 60), mn = tm % 60;
                    const timeStr = `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}`;
                    const flightNo = String(row[m.arrNo]).trim();
                    const isNextDay = tm < 900; // 15:00'dan önce ertesi gün (parse ile tutarlı)
                    const existing = app.state.flights.find(f => f.flightNo === flightNo && f.type === 'ARR' && f.isNextDay === isNextDay);
                    if (existing) {
                        const newGate = String(gate).trim();
                        if (existing.originalGate !== newGate) {
                            existing.originalGate = newGate;
                            app.state.gates[existing.id] = newGate;
                            existing.wasUpdated = true;
                            existing.gateUpdated = true;
                            stats.updated++;

                            // Bağlı uçuşu da güncelle (pairId ile)
                            if (existing.pairId) {
                                const paired = app.state.flights.find(f => f.pairId === existing.pairId && f.id !== existing.id);
                                if (paired) {
                                    paired.originalGate = newGate;
                                    app.state.gates[paired.id] = newGate;
                                    paired.wasUpdated = true;
                                    paired.gateUpdated = true;
                                }
                            }
                        } else { stats.unchanged++; }
                    } else {
                        // Yeni uçuş ekle
                        const pairId = `pair-${idx}-${Math.random().toString(36).substr(2, 4)}`;
                        const baseDate = app.state.baseDate ? new Date(app.state.baseDate) : new Date();
                        const routeRaw = row[m.route] || ""; let from = routeRaw; if (routeRaw.includes("-")) from = routeRaw.split("-")[0].trim();
                        const isNextDay = tm < 900; const d = new Date(baseDate); if (isNextDay) d.setDate(d.getDate() + 1); d.setHours(h, mn, 0, 0);
                        app.state.flights.push({ id: `ARR-${idx}-${Math.random().toString(36).substr(2, 5)}`, type: 'ARR', flightNo: flightNo, flightNoOnly: flightNo.match(/\d+/)?.[0] || flightNo, rawAirline: String(air).trim(), airline: String(air).split('/')[0].trim(), gate: String(gate).trim(), originalGate: String(gate).trim(), route: from, timestamp: d.getTime(), timeStr: timeStr, isNextDay: isNextDay, pairId: pairId, wasUpdated: true });
                        stats.added++;
                    }
                }
                // DEP uçuşunu kontrol et
                if (row[m.depNo] && row[m.depTime]) {
                    const tm = toMins(row[m.depTime]); if (tm === null) return;
                    const h = Math.floor(tm / 60), mn = tm % 60;
                    const timeStr = `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}`;
                    const flightNo = String(row[m.depNo]).trim();
                    const isNextDay = tm < 900; // 15:00'dan önce ertesi gün (parse ile tutarlı)
                    const existing = app.state.flights.find(f => f.flightNo === flightNo && f.type === 'DEP' && f.isNextDay === isNextDay);
                    if (existing) {
                        const newGate = String(gate).trim();
                        if (existing.originalGate !== newGate) {
                            existing.originalGate = newGate;
                            app.state.gates[existing.id] = newGate;
                            existing.wasUpdated = true;
                            existing.gateUpdated = true;
                            stats.updated++;

                            // Bağlı uçuşu da güncelle (pairId ile)
                            if (existing.pairId) {
                                const paired = app.state.flights.find(f => f.pairId === existing.pairId && f.id !== existing.id);
                                if (paired) {
                                    paired.originalGate = newGate;
                                    app.state.gates[paired.id] = newGate;
                                    paired.wasUpdated = true;
                                    paired.gateUpdated = true;
                                }
                            }
                        } else { stats.unchanged++; }
                    } else {
                        // Yeni uçuş ekle
                        const pairId = `pair-${idx}-${Math.random().toString(36).substr(2, 4)}`;
                        const baseDate = app.state.baseDate ? new Date(app.state.baseDate) : new Date();
                        const routeRaw = row[m.route] || ""; let to = routeRaw; if (routeRaw.includes("-")) to = routeRaw.split("-")[1]?.trim() || routeRaw;
                        const isNextDay = tm < 900; const d = new Date(baseDate); if (isNextDay) d.setDate(d.getDate() + 1); d.setHours(h, mn, 0, 0);
                        app.state.flights.push({ id: `DEP-${idx}-${Math.random().toString(36).substr(2, 5)}`, type: 'DEP', flightNo: flightNo, flightNoOnly: flightNo.match(/\d+/)?.[0] || flightNo, rawAirline: String(air).trim(), airline: String(air).split('/')[0].trim(), gate: String(gate).trim(), originalGate: String(gate).trim(), route: to, timestamp: d.getTime(), timeStr: timeStr, isNextDay: isNextDay, pairId: pairId, wasUpdated: true });
                        stats.added++;
                    }
                }
            });
            app.state.flights.sort((a, b) => a.timestamp - b.timestamp);
            app.logic.pendingExcelData = null;
            document.getElementById('excelMergeModal')?.classList.add('hidden');
            app.data.save(); app.ui.render();
            app.ui.toast(`Güncelleme: ${stats.updated} değişti, ${stats.added} yeni, ${stats.unchanged} aynı`, 'success');
        },
        replaceWithNewExcel: () => {
            if (!app.logic.pendingExcelData) return;
            document.getElementById('excelMergeModal')?.classList.add('hidden');
            app.logic.parse(app.logic.pendingExcelData);
            app.logic.pendingExcelData = null;
        },
        parse: (rows) => {
            let hIdx = -1, dateStr = "";
            for (let i = 0; i < Math.min(rows.length, 25); i++) { if (!rows[i]) continue; const s = rows[i].join(" ").toUpperCase(); if (s.match(/(\d{2}\.\d{2}\.\d{4})/)) dateStr = s.match(/(\d{2}\.\d{2}\.\d{4})/)[1]; if (s.includes("FLIGHT NO") && s.includes("AIRLINE")) { hIdx = i; break; } }
            if (hIdx === -1) { app.ui.toast("Header Bulunamadı!", "error"); return; }
            const header = rows[hIdx].map(x => String(x).toUpperCase().trim());
            const m = { airline: -1, gate: -1, route: -1, arrNo: -1, arrTime: -1, depNo: -1, depTime: -1 };
            header.forEach((c, i) => { if (c.includes("AIRLINE")) m.airline = i; if (c.includes("BRIDGE") || c.includes("GATE")) m.gate = i; if (c.includes("STATIONS") || c.includes("ROUTE")) m.route = i; });
            const split = Math.floor(header.length / 2);
            header.forEach((c, i) => { if (i < split) { if (c.includes("FLIGHT") || c.includes("NO")) m.arrNo = i; if (c.includes("STA") || c.includes("TIME")) m.arrTime = i; } else { if ((c.includes("FLIGHT") || c.includes("NO")) && m.depNo === -1) m.depNo = i; if ((c.includes("STD") || c.includes("TIME")) && m.depTime === -1) m.depTime = i; } });
            const toMins = (v) => { if (typeof v === 'number') return Math.round(v * 1440); if (typeof v === 'string' && v.includes(':')) { const [h, m] = v.split(':').map(Number); return h * 60 + m; } return null; };
            const data = rows.slice(hIdx + 1); app.state.flights = []; let baseDate = new Date(); if (dateStr) { const p = dateStr.split('.'); baseDate = new Date(p[2], p[1] - 1, p[0]); } app.state.baseDate = baseDate.toISOString();
            data.forEach((row, idx) => {
                const air = row[m.airline] || ""; const gate = row[m.gate] || ""; const routeRaw = row[m.route] || ""; let from = routeRaw, to = routeRaw; if (routeRaw.includes("-")) { const p = routeRaw.split("-"); from = p[0].trim(); to = p[1].trim(); }
                const pairId = `pair-${idx}-${Math.random().toString(36).substr(2, 4)}`;
                const createFlight = (t, type, no, route, pair) => { const isNextDay = t < 900; const d = new Date(baseDate); if (isNextDay) d.setDate(d.getDate() + 1); const h = Math.floor(t / 60), mn = t % 60; d.setHours(h, mn, 0, 0); const fClean = String(no).trim(); const numMatch = fClean.match(/\d+/); const fNum = numMatch ? numMatch[0] : fClean; return { id: `${type}-${idx}-${Math.random().toString(36).substr(2, 5)}`, type: type, flightNo: fClean, flightNoOnly: fNum, rawAirline: String(air).trim(), airline: String(air).split('/')[0].trim(), gate: String(gate).trim(), originalGate: String(gate).trim(), route: route, timestamp: d.getTime(), timeStr: `${String(h).padStart(2, '0')}:${String(mn).padStart(2, '0')}`, isNextDay: isNextDay, pairId: pair }; };
                if (row[m.arrNo] && row[m.arrTime]) { const tm = toMins(row[m.arrTime]); if (tm !== null) app.state.flights.push(createFlight(tm, 'ARR', row[m.arrNo], from, pairId)); }
                if (row[m.depNo] && row[m.depTime]) { const tm = toMins(row[m.depTime]); if (tm !== null) app.state.flights.push(createFlight(tm, 'DEP', row[m.depNo], to, pairId)); }
            });
            app.state.flights.sort((a, b) => a.timestamp - b.timestamp); app.data.save();
            // TRIGGER WIZARD
            app.ui.showShiftConfig();
            app.ui.toast("Dosya Okundu. Vardiya Seçin.", "success");
        },
        applyShiftConfig: () => {
            if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); document.getElementById('shiftConfigModal').classList.add('hidden'); return; }
            let type = 'all'; if (document.getElementById('sc-btn-day').classList.contains('active')) type = 'day'; else if (document.getElementById('sc-btn-night').classList.contains('active')) type = 'night';
            const startVal = document.getElementById('sc-start').value; const endVal = document.getElementById('sc-end').value;
            const timeToMins = (t) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
            let startMins = timeToMins(startVal); let endMins = timeToMins(endVal);
            if (endMins < startMins) { endMins += 1440; }
            app.state.shift = type; app.state.customStart = startMins; app.state.customEnd = endMins;
            document.getElementById('shiftConfigModal').classList.add('hidden'); app.ui.updateHeaderShiftLabel(); app.ui.render(); app.data.save(); app.ui.toast("Vardiya Başlatıldı", "success");
        },
        setShift: (s) => { if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); return; } app.ui.showShiftConfig(); }, // Re-opens wizard
        // History için yardımcı fonksiyonlar
        pushHistory: () => {
            const snapshot = JSON.stringify({
                flights: JSON.parse(JSON.stringify(app.state.flights)), // Deep copy
                assignments: app.state.assignments,
                gates: app.state.gates,
                overrides: app.state.overrides,
                completed: app.state.completed,
                delayed: app.state.delayed,
                timeChanges: app.state.timeChanges
            });
            if (!app.state.history) app.state.history = [];
            app.state.history.push(snapshot);
            if (app.state.history.length > 10) app.state.history.shift();
        },
        undo: () => {
            if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); return; }
            if (!app.state.history || app.state.history.length === 0) { app.ui.toast("Geri alınacak işlem yok", "info"); return; }
            const prev = JSON.parse(app.state.history.pop());
            if (prev.flights) app.state.flights = prev.flights;
            app.state.assignments = prev.assignments || {};
            app.state.gates = prev.gates || {};
            app.state.overrides = prev.overrides || {};
            app.state.completed = prev.completed || [];
            app.state.delayed = prev.delayed || {};
            app.state.timeChanges = prev.timeChanges || {};
            app.data.save(); app.ui.render(); app.ui.renderStaff();
            app.ui.toast("Son işlem geri alındı", "success");
        },
        clearUpdateBadges: () => {
            app.state.flights.forEach(f => { delete f.wasUpdated; delete f.gateUpdated; });
            app.state.timeChanges = {};
            app.data.save(); app.ui.render();
            app.ui.toast("Güncelleme işaretleri temizlendi", "success");
        },
        toggleUpdatedFilter: () => {
            app.localFilters.showUpdatedOnly = !app.localFilters.showUpdatedOnly;
            const btn = document.getElementById('btnUpdatedFilter');
            if (btn) btn.classList.toggle('bg-amber-500/20', app.localFilters.showUpdatedOnly);
            app.ui.render();
            app.ui.toast(app.localFilters.showUpdatedOnly ? "Sadece güncellenmiş" : "Tümü görünüyor", "info");
        },
        // Uçuş değişiklik geçmişi
        logHistory: (id, field, oldValue, newValue) => {
            if (!app.state.flightHistory) app.state.flightHistory = {};
            if (!app.state.flightHistory[id]) app.state.flightHistory[id] = [];
            app.state.flightHistory[id].push({ timestamp: Date.now(), field, oldValue, newValue });
            if (app.state.flightHistory[id].length > 10) app.state.flightHistory[id].shift();
        },
        toggleOverride: (id, act) => { if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); return; } app.logic.pushHistory(); if (app.state.overrides[id] === act) delete app.state.overrides[id]; else app.state.overrides[id] = act; app.data.save(); app.ui.render(); },
        toggleComplete: (id) => { if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); return; } app.logic.pushHistory(); if (app.state.completed.includes(id)) app.state.completed = app.state.completed.filter(x => x !== id); else app.state.completed.push(id); app.data.save(); app.ui.render(); app.ui.renderStaff(); },
        toggleDelay: (id) => { if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); return; } app.logic.pushHistory(); if (app.state.delayed[id]) delete app.state.delayed[id]; else app.state.delayed[id] = true; app.data.save(); app.ui.render(); },
        assignStaff: (id, val) => { if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); return; } app.logic.pushHistory(); app.state.assignments[id] = val; app.data.save(); app.ui.render(); app.ui.renderStaff(); },
        updateGate: (id, val) => {
            if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); return; }
            app.logic.pushHistory();
            const flight = app.state.flights.find(f => f.id === id);
            const oldGate = app.state.gates[id] || (flight ? flight.originalGate : '');
            app.state.gates[id] = val;
            // Geçmişe kaydet
            app.logic.logHistory(id, 'Kapı', oldGate, val);
            // Bağlı uçuşu da güncelle (aynı pairId'ye sahip)
            if (flight && flight.pairId) {
                const paired = app.state.flights.find(f => f.pairId === flight.pairId && f.id !== id);
                if (paired) {
                    const oldPairedGate = app.state.gates[paired.id] || paired.originalGate;
                    app.state.gates[paired.id] = val;
                    app.logic.logHistory(paired.id, 'Kapı', oldPairedGate, val);
                    app.ui.toast(`Bağlı ${paired.type === 'ARR' ? 'iniş' : 'kalkış'} da güncellendi`, 'info');
                }
            }
            app.data.save(); app.ui.render();
        },
        updateFlightTime: (id, newTime) => {
            if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); return; }
            console.log('updateFlightTime called:', id, newTime);
            if (!newTime) { console.log('No new time provided'); return; }
            const flight = app.state.flights.find(f => f.id === id);
            if (!flight) { console.log('Flight not found:', id); return; }

            // Aynı saat ise işlem yapma
            if (flight.timeStr === newTime) { console.log('Same time, skipping'); return; }

            app.logic.pushHistory();
            const originalTime = flight.originalTimeStr || flight.timeStr;
            flight.originalTimeStr = flight.originalTimeStr || flight.timeStr;
            flight.timeStr = newTime;

            const [h, m] = newTime.split(':').map(Number);
            const baseDate = app.state.baseDate ? new Date(app.state.baseDate) : new Date();
            const d = new Date(baseDate);
            const mins = h * 60 + m;
            flight.isNextDay = mins < 360;
            if (flight.isNextDay) d.setDate(d.getDate() + 1);
            d.setHours(h, m, 0, 0);
            flight.timestamp = d.getTime();

            // timeChanges'e kaydet (badge için)
            if (newTime !== originalTime) {
                if (!app.state.timeChanges) app.state.timeChanges = {};
                app.state.timeChanges[id] = { original: originalTime, new: newTime };
                app.logic.logHistory(id, 'Saat', originalTime, newTime);
                console.log('Time changed:', originalTime, '->', newTime);
            } else {
                delete app.state.timeChanges[id];
            }

            // Yeniden sırala
            app.state.flights.sort((a, b) => a.timestamp - b.timestamp);

            app.data.save();
            app.ui.render();
            app.ui.toast(`Saat güncellendi: ${originalTime} → ${newTime}`, 'success');
        },
        addManualFlight: () => {
            if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); return; }
            const type = document.getElementById('af-type-arr').className.includes('bg-emerald-500') ? 'ARR' : 'DEP';
            const time = document.getElementById('af-time').value;
            const flightNo = document.getElementById('af-flightno').value.trim().toUpperCase();
            const airline = document.getElementById('af-airline').value.trim().toUpperCase();
            const route = document.getElementById('af-route').value.trim().toUpperCase();
            const gate = document.getElementById('af-gate').value.trim();
            if (!time) { app.ui.toast('Saat seçiniz!', 'error'); return; }
            if (!flightNo) { app.ui.toast('Uçuş numarası giriniz!', 'error'); return; }
            if (!airline) { app.ui.toast('Havayolu giriniz!', 'error'); return; }
            if (!route) { app.ui.toast('Rota giriniz!', 'error'); return; }
            const [h, m] = time.split(':').map(Number);
            const mins = h * 60 + m;
            const baseDate = app.state.baseDate ? new Date(app.state.baseDate) : new Date();
            const isNextDay = mins < 360;
            const d = new Date(baseDate);
            if (isNextDay) d.setDate(d.getDate() + 1);
            d.setHours(h, m, 0, 0);
            const numMatch = flightNo.match(/\d+/);
            const fNum = numMatch ? numMatch[0] : flightNo;
            const newFlight = {
                id: `MANUAL-${type}-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
                type: type, flightNo: flightNo, flightNoOnly: fNum, rawAirline: airline, airline: airline,
                gate: gate, originalGate: gate, route: route, timestamp: d.getTime(),
                timeStr: `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`, isNextDay: isNextDay, isManual: true
            };
            app.state.flights.push(newFlight);
            app.state.flights.sort((a, b) => a.timestamp - b.timestamp);
            app.data.save(); app.ui.render(); app.ui.toggleAddFlightModal();
            app.ui.toast(`${flightNo} eklendi!`, 'success');
        },

        addStaff: () => { if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); return; } const v = document.getElementById('newStaffName').value.trim().toUpperCase(); if (v && !app.state.staff.includes(v)) { app.state.staff.push(v); document.getElementById('newStaffName').value = ''; app.ui.renderStaff(); app.data.save(); app.ui.toast("Eklendi", "success"); } },
        removeStaff: (s) => { if (!app.isAdmin) { app.ui.toast('Admin yetkisi gerekli', 'error'); return; } app.state.staff = app.state.staff.filter(x => x !== s); app.ui.renderStaff(); app.data.save(); },
        analyze: () => {
            const allFlights = app.state.flights; if (!allFlights.length) return;
            const sortedF = [...allFlights].sort((a, b) => a.timestamp - b.timestamp);

            // Odaklanılan uçuşları filtrele (vardiya seçimine göre + pinlenmiş olanlar)
            const focusFlights = sortedF.filter(flight => {
                // Pinlenmiş uçuşları her zaman dahil et
                if (app.state.overrides[flight.id] === 'focus') return true;
                // Gizlileri hariç tut
                if (app.state.overrides[flight.id] === 'hide') return false;

                const m = new Date(flight.timestamp).getHours() * 60 + new Date(flight.timestamp).getMinutes() + (flight.isNextDay ? 1440 : 0);
                if (app.state.shift === 'all') return true;
                return m >= app.state.customStart && m <= app.state.customEnd;
            });

            // Saatlik yoğunluk
            let hourCounts = {};
            focusFlights.forEach(f => {
                const h = String(new Date(f.timestamp).getHours()).padStart(2, '0');
                hourCounts[h] = (hourCounts[h] || 0) + 1;
            });
            const orderedHours = [...new Set(focusFlights.map(f => String(new Date(f.timestamp).getHours()).padStart(2, '0')))];
            const maxVal = Math.max(...Object.values(hourCounts), 1);
            const chartHtml = orderedHours.map(h => {
                const count = hourCounts[h] || 0;
                const pct = (count / maxVal) * 100;
                const color = count > 5 ? 'bg-red-500' : (count > 2 ? 'bg-amber-500' : 'bg-emerald-500');
                return `<div class="flex flex-col items-center gap-1 min-w-[30px]"><div class="w-full bg-white/5 rounded-t relative h-20 flex items-end"><div class="w-full ${color} opacity-80 rounded-t" style="height: ${pct}%"></div></div><div class="text-[9px] font-mono text-gray-400">${h}</div><div class="text-[8px] font-bold text-white">${count}</div></div>`;
            }).join('');

            // Personel yükü
            let staffLoad = {};
            app.state.staff.forEach(s => staffLoad[s] = { total: 0, done: 0 });
            focusFlights.forEach(f => {
                const s = app.state.assignments[f.id];
                if (s && staffLoad[s]) {
                    staffLoad[s].total++;
                    if (app.state.completed.includes(f.id)) staffLoad[s].done++;
                }
            });
            const staffHtml = Object.entries(staffLoad).filter(([_, v]) => v.total > 0).map(([name, data]) => {
                const pct = data.total > 0 ? Math.round((data.done / data.total) * 100) : 0;
                const color = pct === 100 ? 'bg-emerald-500' : (pct > 50 ? 'bg-blue-500' : 'bg-amber-500');
                return `<div class="flex items-center gap-3 bg-black/20 p-2 rounded-lg"><div class="w-8 h-8 rounded-full ${color}/20 flex items-center justify-center"><i class="fa-solid fa-user text-xs ${color.replace('bg-', 'text-')}"></i></div><div class="flex-1"><div class="text-xs font-bold text-white">${name}</div><div class="w-full bg-white/10 rounded-full h-1.5 mt-1"><div class="${color} h-1.5 rounded-full" style="width: ${pct}%"></div></div></div><div class="text-right"><div class="text-lg font-bold text-white">${data.done}/${data.total}</div><div class="text-[9px] text-gray-500">${pct}%</div></div></div>`;
            }).join('') || '<div class="text-gray-500 text-xs italic">Henüz atama yapılmamış</div>';

            // Değişiklik özeti
            const timeChangedCount = Object.keys(app.state.timeChanges || {}).length;
            const gateChangedCount = focusFlights.filter(f => f.gateUpdated || (app.state.gates[f.id] && app.state.gates[f.id] !== f.originalGate)).length;
            const newAddedCount = focusFlights.filter(f => f.wasUpdated && !f.gateUpdated).length;

            // Tamamlanma oranı (ODAKLANILAN)
            const completedInFocus = focusFlights.filter(f => app.state.completed.includes(f.id)).length;
            const completionPct = focusFlights.length > 0 ? Math.round((completedInFocus / focusFlights.length) * 100) : 0;

            // Gecikme analizi
            const delayedCount = focusFlights.filter(f => app.state.delayed[f.id]).length;
            const delayedFlights = focusFlights.filter(f => app.state.delayed[f.id]).slice(0, 5);
            const delayHtml = delayedFlights.length ? delayedFlights.map(f => `<div class="flex items-center gap-2 bg-red-500/10 p-2 rounded border-l-2 border-red-500"><span class="font-mono text-white text-sm">${f.timeStr}</span><span class="font-bold text-red-400">${f.flightNo}</span></div>`).join('') : '<div class="text-gray-500 text-xs italic">Gecikme yok 🎉</div>';

            // Mola aralıkları (30 dk+)
            let gaps = [];
            for (let i = 0; i < focusFlights.length - 1; i++) {
                const diff = (focusFlights[i + 1].timestamp - focusFlights[i].timestamp) / 60000;
                if (diff >= 30) {
                    gaps.push({ start: focusFlights[i].timeStr, end: focusFlights[i + 1].timeStr, min: Math.floor(diff) });
                }
            }
            const gapsHtml = gaps.length ? gaps.map(g => `<div class="flex justify-between items-center bg-green-500/10 p-2 rounded border-l-2 border-green-500"><span class="font-mono text-white text-sm">${g.start} → ${g.end}</span><span class="font-bold text-green-400">${g.min} dk</span></div>`).join('') : '<div class="text-gray-500 text-xs italic">30 dk+ boşluk yok</div>';

            // Personel bekleyen uçuş sayısı
            const staffPendingHtml = app.state.staff.map(s => {
                const pending = focusFlights.filter(f => app.state.assignments[f.id] === s && !app.state.completed.includes(f.id)).length;
                if (pending === 0) return '';
                return `<div class="flex items-center gap-2 bg-purple-500/10 p-2 rounded"><span class="text-purple-400 font-bold text-sm">${s}</span><span class="text-white font-bold">${pending} uçuş bekliyor</span></div>`;
            }).filter(x => x).join('') || '<div class="text-gray-500 text-xs italic">Tüm atamalar tamamlandı 🎉</div>';


            // Sonraki 1 saat uyarısı
            const now = Date.now();
            const nextHourFlights = focusFlights.filter(f => f.timestamp > now && f.timestamp <= now + 3600000 && !app.state.completed.includes(f.id));
            const urgentAlert = nextHourFlights.length > 0 ? `<div class="bg-gradient-to-r from-amber-500/20 to-red-500/20 border border-amber-500/30 rounded-xl p-4 flex items-center gap-4"><div class="w-12 h-12 rounded-full bg-amber-500/20 flex items-center justify-center animate-pulse"><i class="fa-solid fa-bell text-amber-400 text-xl"></i></div><div><div class="text-amber-400 font-bold text-sm">⚡ YAKLAŞAN UÇUŞLAR</div><div class="text-white text-2xl font-bold">${nextHourFlights.length} uçuş</div><div class="text-gray-400 text-xs">Sonraki 1 saat içinde hazırlan!</div></div></div>` : '';

            // Progress ring
            const progressRing = `<svg class="w-24 h-24" viewBox="0 0 36 36"><path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="rgba(255,255,255,0.1)" stroke-width="3"/><path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="${completionPct === 100 ? '#10b981' : '#3b82f6'}" stroke-width="3" stroke-dasharray="${completionPct}, 100" stroke-linecap="round"/><text x="18" y="20.35" class="fill-white text-[8px] font-bold" text-anchor="middle">${completionPct}%</text></svg>`;

            document.getElementById('analysisContent').innerHTML = `
            <div class="space-y-6">
                ${urgentAlert}
                <div class="grid grid-cols-2 md:grid-cols-4 gap-4">
                    <div class="glass p-4 rounded-xl border-l-4 border-blue-500"><div class="text-[10px] text-blue-400 uppercase font-bold">Odak Uçuş</div><div class="text-3xl font-bold text-white">${focusFlights.length}</div><div class="text-[9px] text-gray-500">/ ${allFlights.length} toplam</div></div>
                    <div class="glass p-4 rounded-xl border-l-4 border-emerald-500"><div class="text-[10px] text-emerald-400 uppercase font-bold">Tamamlanan</div><div class="text-3xl font-bold text-white">${completedInFocus}</div><div class="text-[9px] text-emerald-400">${completionPct}% başarı</div></div>
                    <div class="glass p-4 rounded-xl border-l-4 border-red-500"><div class="text-[10px] text-red-400 uppercase font-bold">Gecikmeli</div><div class="text-3xl font-bold text-white">${delayedCount}</div><div class="text-[9px] text-gray-500">dikkat!</div></div>
                    <div class="glass p-4 rounded-xl border-l-4 border-amber-500"><div class="text-[10px] text-amber-400 uppercase font-bold">Değişiklik</div><div class="text-3xl font-bold text-white">${timeChangedCount + gateChangedCount}</div><div class="text-[9px] text-gray-500">⏰${timeChangedCount} 🚪${gateChangedCount}</div></div>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div class="glass p-4 rounded-xl"><h4 class="text-xs text-gray-400 uppercase font-bold mb-4 flex items-center gap-2"><i class="fa-solid fa-chart-bar text-blue-400"></i> Saatlik Yoğunluk</h4><div class="flex items-end gap-1 overflow-x-auto pb-2">${chartHtml}</div></div>
                    <div class="glass p-4 rounded-xl flex flex-col items-center justify-center"><h4 class="text-xs text-gray-400 uppercase font-bold mb-2">Tamamlanma</h4>${progressRing}<div class="text-xs text-gray-500 mt-2">${completedInFocus} / ${focusFlights.length} uçuş</div></div>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div class="glass p-4 rounded-xl"><h4 class="text-xs text-gray-400 uppercase font-bold mb-3 flex items-center gap-2"><i class="fa-solid fa-users text-purple-400"></i> Personel Yükü</h4><div class="space-y-2 max-h-48 overflow-y-auto custom-scroll pr-2">${staffHtml}</div></div>
                    <div class="glass p-4 rounded-xl"><h4 class="text-xs text-gray-400 uppercase font-bold mb-3 flex items-center gap-2"><i class="fa-solid fa-clock text-red-400"></i> Gecikmeler</h4><div class="space-y-2 max-h-48 overflow-y-auto custom-scroll pr-2">${delayHtml}</div></div>
                </div>
                <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                    <div class="glass p-4 rounded-xl"><h4 class="text-xs text-gray-400 uppercase font-bold mb-3 flex items-center gap-2"><i class="fa-solid fa-coffee text-green-400"></i> Mola Aralıkları (30dk+)</h4><div class="space-y-2 max-h-40 overflow-y-auto custom-scroll pr-2">${gapsHtml}</div></div>
                    <div class="glass p-4 rounded-xl"><h4 class="text-xs text-gray-400 uppercase font-bold mb-3 flex items-center gap-2"><i class="fa-solid fa-user-clock text-purple-400"></i> Bekleyen Uçuşlar</h4><div class="space-y-2 max-h-40 overflow-y-auto custom-scroll pr-2">${staffPendingHtml}</div></div>
                </div>
            </div>`;
        },
        generatePDF: async () => {
            const { jsPDF } = window.jspdf; const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
            app.ui.toast("PDF Hazırlanıyor...", "info");
            const trMap = (str) => str.replace(/Ğ/g, "G").replace(/ğ/g, "g").replace(/Ü/g, "U").replace(/ü/g, "u").replace(/Ş/g, "S").replace(/ş/g, "s").replace(/İ/g, "I").replace(/ı/g, "i").replace(/Ö/g, "O").replace(/ö/g, "o").replace(/Ç/g, "C").replace(/ç/g, "c");

            // Premium Header with gradient effect
            doc.setFillColor(15, 23, 42); doc.rect(0, 0, 297, 44, 'F');
            doc.setFillColor(30, 58, 138); doc.rect(0, 44, 297, 2, 'F');
            doc.setFillColor(59, 130, 246); doc.rect(0, 45, 297, 1, 'F');

            // Logo with glow effect
            doc.setFillColor(30, 41, 59); doc.roundedRect(10, 8, 55, 28, 3, 3, 'F');
            doc.setDrawColor(59, 130, 246); doc.setLineWidth(0.5); doc.roundedRect(10, 8, 55, 28, 3, 3, 'S');
            doc.setTextColor(255, 255, 255); doc.setFontSize(18); doc.setFont("helvetica", "bold");
            doc.text("FOLLOW-ME", 37.5, 20, { align: 'center' });
            doc.setTextColor(59, 130, 246); doc.setFontSize(11); doc.text("OPS CENTER", 37.5, 28, { align: 'center' });

            // Report Title with decoration
            doc.setTextColor(255, 255, 255); doc.setFontSize(22); doc.setFont("helvetica", "bold");
            doc.text("VARDIYA RAPORU", 148, 18, { align: 'center' });
            doc.setDrawColor(59, 130, 246); doc.setLineWidth(0.5);
            doc.line(100, 22, 196, 22);

            let reportDate = new Date(); if (app.state.baseDate) { reportDate = new Date(app.state.baseDate); }
            const dateStr = trMap(reportDate.toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }));
            doc.setTextColor(148, 163, 184); doc.setFontSize(11); doc.setFont("helvetica", "normal");
            doc.text(dateStr.toUpperCase(), 148, 30, { align: 'center' });

            let shiftStr = "TUM GUN"; let shiftClr = [148, 163, 184];
            if (app.state.shift !== 'all') {
                const hStart = Math.floor(app.state.customStart / 60); const hEnd = Math.floor((app.state.customEnd > 1440 ? app.state.customEnd - 1440 : app.state.customEnd) / 60);
                const rangeStr = `${String(hStart).padStart(2, '0')}:00 - ${String(hEnd).padStart(2, '0')}:00`;
                shiftStr = app.state.shift === 'day' ? `GUNDUZ VARDIYASI | ${rangeStr}` : `GECE VARDIYASI | ${rangeStr}`;
                shiftClr = app.state.shift === 'day' ? [251, 191, 36] : [129, 140, 248];
            }
            doc.setTextColor(...shiftClr); doc.setFontSize(10); doc.setFont("helvetica", "bold");
            doc.text(shiftStr, 148, 38, { align: 'center' });

            const buffer = CONSTANTS.PDF_BUFFER_MINUTES; const flights = app.state.flights; let filteredFlights = [];
            if (app.state.shift === 'all') { filteredFlights = flights.map(f => ({ ...f, isBuffer: false })); }
            else {
                const startM = app.state.customStart; const endM = app.state.customEnd;
                const bufStart = startM - buffer; const bufEnd = endM + buffer;
                // Tamamlanan veya pinlenmiş uçuşları her zaman dahil et
                filteredFlights = flights.filter(f => {
                    const date = new Date(f.timestamp);
                    const m = date.getHours() * 60 + date.getMinutes() + (f.isNextDay ? 1440 : 0);
                    const inRange = (m >= bufStart && m <= bufEnd);
                    const isCompleted = app.state.completed.includes(f.id);
                    const isPinned = app.state.overrides[f.id] === 'focus';
                    return inRange || isCompleted || isPinned;
                }).map(f => {
                    const date = new Date(f.timestamp);
                    const m = date.getHours() * 60 + date.getMinutes() + (f.isNextDay ? 1440 : 0);
                    const isBuffer = (m < startM || m > endM);
                    return { ...f, isBuffer };
                });
            }

            // Enhanced Stats Cards
            const totalC = filteredFlights.filter(f => !f.isBuffer).length;
            const doneC = filteredFlights.filter(f => app.state.completed.includes(f.id)).length;
            const doneArrC = filteredFlights.filter(f => app.state.completed.includes(f.id) && f.type === 'ARR').length;
            const doneDepC = filteredFlights.filter(f => app.state.completed.includes(f.id) && f.type === 'DEP').length;
            const arrC = filteredFlights.filter(f => !f.isBuffer && f.type === 'ARR').length;
            const depC = filteredFlights.filter(f => !f.isBuffer && f.type === 'DEP').length;
            const timeChangedC = filteredFlights.filter(f => !f.isBuffer && app.state.timeChanges && app.state.timeChanges[f.id]).length;

            // Stats Box - Toplam
            doc.setFillColor(30, 41, 59); doc.roundedRect(215, 8, 35, 28, 2, 2, 'F');
            doc.setDrawColor(59, 130, 246); doc.setLineWidth(0.3); doc.roundedRect(215, 8, 35, 28, 2, 2, 'S');

            doc.setTextColor(148, 163, 184); doc.setFontSize(7); doc.setFont("helvetica", "normal");
            doc.text("TOPLAM", 232.5, 14, { align: 'center' });
            doc.setTextColor(255, 255, 255); doc.setFontSize(16); doc.setFont("helvetica", "bold");
            doc.text(String(totalC), 232.5, 24, { align: 'center' });
            doc.setFontSize(7);
            doc.setTextColor(16, 185, 129); doc.text(`${arrC} inis`, 222, 32);
            doc.setTextColor(245, 158, 11); doc.text(`${depC} kalkis`, 222, 36);

            // Stats Box - Tamamlanan
            doc.setFillColor(30, 41, 59); doc.roundedRect(255, 8, 35, 28, 2, 2, 'F');
            doc.setDrawColor(16, 185, 129); doc.setLineWidth(0.3); doc.roundedRect(255, 8, 35, 28, 2, 2, 'S');

            doc.setTextColor(16, 185, 129); doc.setFontSize(7); doc.setFont("helvetica", "normal");
            doc.text("TAMAMLANAN", 272.5, 14, { align: 'center' });
            doc.setTextColor(16, 185, 129); doc.setFontSize(16); doc.setFont("helvetica", "bold");
            doc.text(String(doneC), 272.5, 24, { align: 'center' });
            doc.setFontSize(7);
            doc.setTextColor(16, 185, 129); doc.text(`${doneArrC} inis`, 262, 32);
            doc.setTextColor(16, 185, 129); doc.text(`${doneDepC} kalkis`, 262, 36);

            // Build table rows with time change support
            const rows = filteredFlights.map(f => {
                const savedGate = app.state.gates[f.id] !== undefined ? app.state.gates[f.id] : (f.originalGate || "");
                const isGateChanged = String(savedGate).trim() !== String(f.originalGate || "").trim();
                const gateDisplay = isGateChanged ? `${savedGate} (!)` : savedGate;

                // Saat değişikliği kontrolü
                const timeChange = app.state.timeChanges && app.state.timeChanges[f.id];
                let timeDisplay = f.timeStr;
                if (timeChange) {
                    timeDisplay = `${timeChange.original} > ${timeChange.new}`;
                }

                const isCompleted = app.state.completed.includes(f.id);
                return [
                    timeDisplay,
                    f.type === 'ARR' ? 'GELIS' : 'GIDIS',
                    f.flightNo,
                    trMap(f.airline),
                    gateDisplay,
                    trMap(f.route),
                    trMap(app.state.assignments[f.id] || '-'),
                    isCompleted ? 'TAMAMLANDI' : 'BEKLIYOR'
                ];
            });

            doc.autoTable({
                startY: 46,
                margin: { top: 15, bottom: 30, left: 10, right: 10 },
                tableWidth: 'auto',
                head: [['SAAT', 'TIP', 'UCUS NO', 'HAVAYOLU', 'PARK', 'ROTA', 'SORUMLU', 'DURUM']],
                body: rows,
                theme: 'striped',
                styles: { font: 'helvetica', fontSize: 9, cellPadding: 3, textColor: [51, 65, 85], overflow: 'linebreak' },
                headStyles: { fillColor: [30, 41, 59], textColor: [255, 255, 255], fontStyle: 'bold', fontSize: 8, cellPadding: 3.5 },
                columnStyles: {
                    0: { fontStyle: 'bold', halign: 'center', cellWidth: 32 },
                    1: { fontStyle: 'bold', halign: 'center', cellWidth: 24 },
                    2: { fontStyle: 'bold', halign: 'center', cellWidth: 34 },
                    3: { halign: 'left', cellWidth: 42 },
                    4: { fontStyle: 'bold', halign: 'center', cellWidth: 24 },
                    5: { halign: 'center', cellWidth: 38 },
                    6: { halign: 'center', cellWidth: 48 },
                    7: { halign: 'center', cellWidth: 35, fontStyle: 'bold' }
                },
                alternateRowStyles: { fillColor: [248, 250, 252] },
                didParseCell: (data) => {
                    if (data.section === 'body') {
                        const flight = filteredFlights[data.row.index];
                        if (flight && flight.isBuffer) {
                            data.cell.styles.textColor = [156, 163, 175];
                            data.cell.styles.fontStyle = 'italic';
                        } else {
                            if (data.column.index === 0 && data.cell.raw.includes('>')) {
                                data.cell.styles.textColor = [59, 130, 246];
                                data.cell.styles.fontStyle = 'bold';
                            }
                            if (data.column.index === 1) {
                                data.cell.styles.textColor = data.cell.raw === 'GELIS' ? [16, 185, 129] : [245, 158, 11];
                            }
                            if (data.column.index === 4 && data.cell.raw.includes('(!)')) {
                                data.cell.styles.textColor = [239, 68, 68];
                            }
                            if (data.column.index === 7) {
                                data.cell.styles.textColor = data.cell.raw === 'TAMAMLANDI' ? [16, 185, 129] : [148, 163, 184];
                            }
                        }
                    }
                }
            });

            // Footer with explanations
            const pageCount = doc.internal.getNumberOfPages();
            for (let i = 1; i <= pageCount; i++) {
                doc.setPage(i);

                // Footer area - A4 landscape = 210mm height, table ends at 180mm (210-30 margin)
                const footerY = 180;

                // Page info
                doc.setFontSize(8); doc.setTextColor(100, 116, 139); doc.setFont("helvetica", "normal");
                doc.text("FOLLOW-ME OPS CENTER", 14, footerY);
                doc.text(`Sayfa ${i} / ${pageCount}`, 148, footerY, { align: 'center' });
                doc.text(new Date().toLocaleDateString('tr-TR'), 283, footerY, { align: 'right' });

                // Separator line
                doc.setDrawColor(200, 210, 220); doc.setLineWidth(0.3);
                doc.line(14, footerY + 3, 283, footerY + 3);

                // Explanatory notes
                doc.setFontSize(6); doc.setTextColor(100, 116, 139);
                let notesY = footerY + 8;
                doc.text("(!) isaretli park alanlari manuel degistirilmistir.", 14, notesY);
                if (timeChangedC > 0) {
                    doc.setTextColor(59, 130, 246);
                    doc.text(`Mavi ile gosterilen saatler degistirilmistir (eski saat > yeni saat formatinda). Toplam ${timeChangedC} saat degisikligi.`, 14, notesY + 4);
                    notesY += 4;
                }
                doc.setTextColor(100, 116, 139);
                doc.text("Not: Vardiya sorumluluk sahasinin ±20 dakika toleransindaki ucuslar rapora dahil edilmistir.", 14, notesY + 4);
            }

            doc.save(`FollowMe_Rapor_${new Date().toISOString().slice(0, 10)}.pdf`);
            app.ui.toast("PDF İndirildi", "success");
        },
        generateVisualReport: async () => {
            app.ui.toast("Görsel Hazırlanıyor...", "info");
            const container = document.createElement('div'); container.id = 'reportCapture';
            container.style.cssText = 'position:fixed;left:0;top:0;width:1200px;height:675px;z-index:9999';
            document.body.appendChild(container);
            const flights = app.state.flights; let plannedCount = 0;
            const shiftFiltered = flights.filter(f => {
                const date = new Date(f.timestamp); const m = date.getHours() * 60 + date.getMinutes() + (f.isNextDay ? 1440 : 0);
                if (app.state.shift === 'all') return true;
                return (m >= app.state.customStart && m <= app.state.customEnd);
            });
            shiftFiltered.forEach(f => { plannedCount++; });
            const servedIDs = app.state.completed; const servedFlights = flights.filter(f => servedIDs.includes(f.id)); const servedCount = servedFlights.length;
            const servedArr = servedFlights.filter(f => f.type === 'ARR').length; const servedDep = servedFlights.filter(f => f.type === 'DEP').length;
            const totalArr = shiftFiltered.filter(f => f.type === 'ARR').length; const totalDep = shiftFiltered.filter(f => f.type === 'DEP').length;
            const dateStr = app.state.baseDate ? new Date(app.state.baseDate).toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }) : new Date().toLocaleDateString('tr-TR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
            const hStart = Math.floor(app.state.customStart / 60); const hEnd = Math.floor((app.state.customEnd > 1440 ? app.state.customEnd - 1440 : app.state.customEnd) / 60);
            const rangeStr = app.state.shift === 'all' ? 'TÜM GÜN' : `${String(hStart).padStart(2, '0')}:00 - ${String(hEnd).padStart(2, '0')}:00`;
            const shiftName = app.state.shift === 'all' ? 'TÜM GÜN' : (app.state.shift === 'day' ? 'GÜNDÜZ VARDİYASI' : 'GECE VARDİYASI');
            const shiftColor = app.state.shift === 'day' ? '#fbbf24' : (app.state.shift === 'night' ? '#818cf8' : '#94a3b8');
            const shiftGradient = app.state.shift === 'day' ? 'linear-gradient(135deg, #f59e0b 0%, #d97706 100%)' : (app.state.shift === 'night' ? 'linear-gradient(135deg, #6366f1 0%, #4f46e5 100%)' : 'linear-gradient(135deg, #64748b 0%, #475569 100%)');

            container.innerHTML = `<div style="width:100%;height:100%;background:linear-gradient(135deg,#0f172a 0%,#1e293b 50%,#0f172a 100%);padding:40px;font-family:'Inter',sans-serif;display:flex;flex-direction:column;position:relative;overflow:hidden;">
                <div style="position:absolute;top:-100px;right:-100px;width:400px;height:400px;background:radial-gradient(circle,rgba(59,130,246,0.12) 0%,transparent 70%);border-radius:50%;"></div>
                <div style="position:absolute;bottom:-100px;left:-100px;width:350px;height:350px;background:radial-gradient(circle,rgba(16,185,129,0.10) 0%,transparent 70%);border-radius:50%;"></div>
                <div style="display:flex;justify-content:space-between;align-items:flex-start;z-index:10;margin-bottom:30px;">
                    <div>
                        <div style="display:flex;align-items:center;gap:14px;margin-bottom:12px;">
                            <div style="width:45px;height:45px;background:${shiftGradient};border-radius:12px;display:flex;align-items:center;justify-content:center;box-shadow:0 8px 25px -5px ${shiftColor}55;">
                                <svg style="width:24px;height:24px;color:white;" fill="currentColor" viewBox="0 0 24 24"><path d="M21 16v-2l-8-5V3.5c0-.83-.67-1.5-1.5-1.5S10 2.67 10 3.5V9l-8 5v2l8-2.5V19l-2 1.5V22l3.5-1 3.5 1v-1.5L13 19v-5.5l8 2.5z"/></svg>
                            </div>
                            <div style="font-size:12px;font-weight:600;color:#64748b;letter-spacing:3px;text-transform:uppercase;">Vardiya Performans Raporu</div>
                        </div>
                        <div style="font-size:36px;font-weight:800;color:white;line-height:1.1;margin-bottom:6px;">${shiftName}</div>
                        <div style="display:flex;align-items:center;gap:16px;">
                            <span style="font-size:16px;color:#94a3b8;font-weight:500;">${dateStr}</span>
                            <span style="font-size:12px;color:${shiftColor};font-weight:700;background:rgba(255,255,255,0.05);padding:5px 12px;border-radius:6px;border:1px solid rgba(255,255,255,0.1);">${rangeStr}</span>
                        </div>
                    </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1.5fr 1fr;gap:20px;z-index:10;flex:1;">
                    <div style="background:rgba(30,41,59,0.6);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:24px;display:flex;flex-direction:column;justify-content:center;">
                        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;">Planlanan</div>
                        <div style="font-size:52px;font-weight:800;color:#94a3b8;line-height:1;">${plannedCount}</div>
                        <div style="font-size:11px;color:#475569;margin-top:8px;">toplam uçuş</div>
                    </div>
                    <div style="background:linear-gradient(135deg,rgba(16,185,129,0.12) 0%,rgba(16,185,129,0.04) 100%);backdrop-filter:blur(10px);border:1px solid rgba(16,185,129,0.25);border-radius:20px;padding:28px;position:relative;overflow:hidden;">
                        <div style="position:absolute;top:-25px;right:-25px;width:90px;height:90px;background:rgba(16,185,129,0.08);border-radius:50%;"></div>
                        <div style="font-size:10px;font-weight:700;color:#10b981;text-transform:uppercase;letter-spacing:2px;margin-bottom:8px;">Hizmet Verilen</div>
                        <div style="font-size:64px;font-weight:800;color:white;line-height:1;text-shadow:0 4px 16px rgba(16,185,129,0.3);">${servedCount}</div>
                        <div style="display:flex;gap:12px;margin-top:18px;">
                            <div style="background:rgba(16,185,129,0.12);padding:8px 14px;border-radius:10px;display:flex;align-items:center;gap:8px;border:1px solid rgba(16,185,129,0.15);">
                                <svg style="width:14px;height:14px;color:#34d399;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M19 14l-7 7m0 0l-7-7m7 7V3"/></svg>
                                <span style="font-size:18px;font-weight:800;color:white;">${servedArr}</span>
                                <span style="font-size:10px;font-weight:700;color:#34d399;text-transform:uppercase;">Geliş</span>
                            </div>
                            <div style="background:rgba(245,158,11,0.12);padding:8px 14px;border-radius:10px;display:flex;align-items:center;gap:8px;border:1px solid rgba(245,158,11,0.15);">
                                <svg style="width:14px;height:14px;color:#fbbf24;" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2.5" d="M5 10l7-7m0 0l7 7m-7-7v18"/></svg>
                                <span style="font-size:18px;font-weight:800;color:white;">${servedDep}</span>
                                <span style="font-size:10px;font-weight:700;color:#fbbf24;text-transform:uppercase;">Gidiş</span>
                            </div>
                        </div>
                    </div>
                    <div style="background:rgba(30,41,59,0.6);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,0.08);border-radius:20px;padding:24px;display:flex;flex-direction:column;justify-content:center;">
                        <div style="font-size:10px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:2px;margin-bottom:10px;">Planlanan Dağılım</div>
                        <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px;">
                            <div style="display:flex;align-items:center;gap:8px;"><div style="width:10px;height:10px;background:#10b981;border-radius:50%;"></div><span style="font-size:14px;color:white;font-weight:600;">${totalArr}</span><span style="font-size:11px;color:#64748b;">geliş</span></div>
                            <div style="display:flex;align-items:center;gap:8px;"><div style="width:10px;height:10px;background:#f59e0b;border-radius:50%;"></div><span style="font-size:14px;color:white;font-weight:600;">${totalDep}</span><span style="font-size:11px;color:#64748b;">gidiş</span></div>
                        </div>
                    </div>
                </div>
                <div style="z-index:10;margin-top:20px;">
                    <div style="font-size:14px;color:#cbd5e1;font-weight:400;line-height:1.6;border-left:3px solid #3b82f6;padding:14px 18px;background:rgba(59,130,246,0.04);border-radius:0 10px 10px 0;">
                        Vardiyamızda <span style="color:white;font-weight:600;">${plannedCount}</span> adet uçuş planlanmış olup, <span style="color:#34d399;font-weight:600;">${servedArr}</span> geliş ve <span style="color:#fbbf24;font-weight:600;">${servedDep}</span> gidiş olmak üzere toplam <span style="color:#10b981;font-weight:600;">${servedCount}</span> adet Follow-Me hizmeti verilmiştir.
                    </div>
                </div>
                <div style="display:flex;justify-content:space-between;align-items:center;border-top:1px solid rgba(255,255,255,0.06);padding-top:16px;z-index:10;margin-top:20px;">
                    <div style="display:flex;align-items:center;gap:8px;">
                        <div style="width:6px;height:6px;background:#10b981;border-radius:50%;box-shadow:0 0 8px #10b981;"></div>
                        <span style="font-size:10px;color:#475569;font-weight:600;text-transform:uppercase;letter-spacing:1px;">Follow-Me Ops Center</span>
                    </div>
                    <div style="display:flex;align-items:center;gap:6px;font-size:11px;font-weight:600;color:#10b981;background:rgba(16,185,129,0.08);padding:6px 12px;border-radius:6px;">
                        <svg style="width:12px;height:12px;" fill="currentColor" viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41L9 16.17z"/></svg>
                        Vardiya Tamamlandı
                    </div>
                </div>
            </div>`;
            try {
                const canvas = await html2canvas(container, { backgroundColor: null, scale: 2 });
                const link = document.createElement('a');
                link.download = `Vardiya_Ozeti_${new Date().toISOString().slice(0, 10)}.png`;
                link.href = canvas.toDataURL();
                link.click();
                document.body.removeChild(container);
                app.ui.toast("Görsel İndirildi", "success");
            } catch (err) { console.error("Canvas error:", err); document.body.removeChild(container); app.ui.toast("Görsel Hatası", "error"); }
        },

    },
    data: {
        // Firestore'a kaydet - SADECE ADMİN + TIMESTAMP KONTROLÜ
        save: async () => {
            // Admin değilse kaydetme!
            if (!app.isAdmin) {
                console.log('⚠️ Kullanıcı modunda kayıt yapılamaz');
                return;
            }

            // Yazma izni kontrolü (visibility lock)
            if (!app.canWrite) {
                console.log('⚠️ Yazma izni yok - sayfa inaktif');
                return;
            }

            // Firestore'a kaydet
            if (typeof db !== 'undefined') {
                try {
                    // Önce remote timestamp'ı kontrol et
                    const doc = await db.collection('appState').doc('main').get();
                    const remoteTimestamp = doc.exists ? (doc.data().lastUpdated || 0) : 0;

                    // Eğer remote daha yeni ise ve fark 5 saniyeden fazla ise
                    if (remoteTimestamp > app.state.lastUpdated && (remoteTimestamp - app.state.lastUpdated) > 5000) {
                        console.log('⚠️ Çakışma tespit edildi! Remote:', remoteTimestamp, 'Local:', app.state.lastUpdated);
                        app.ui.showConflictWarning(remoteTimestamp);
                        return; // Kaydetme, kullanıcıya sor
                    }

                    // Timestamp'ı güncelle
                    app.state.lastUpdated = Date.now();

                    await db.collection('appState').doc('main').set(app.state);
                    const el = document.getElementById('saveStatus');
                    if (el) {
                        el.style.opacity = '1';
                        el.innerHTML = '<i class="fa-solid fa-cloud-arrow-up animate-bounce text-green-400"></i> <span class="text-green-400">SENKRON</span>';
                        setTimeout(() => el.style.opacity = '0', 2000);
                    }
                    console.log('✅ Firestore\'a kaydedildi - Timestamp:', app.state.lastUpdated);
                } catch (err) {
                    console.error('Firestore save error:', err);
                    app.ui.toast('Senkronizasyon hatası', 'error');
                }
            }
        },

        // Firestore'dan yükle ve gerçek zamanlı dinle
        load: () => {
            // Firestore gerçek zamanlı listener - TEK KAYNAK
            if (typeof db !== 'undefined') {
                // Güçlendirilmiş listener - hem cache hem sunucu değişikliklerini yakala
                db.collection('appState').doc('main').onSnapshot(
                    { includeMetadataChanges: true }, // Tüm değişiklikleri yakala
                    (doc) => {
                        const source = doc.metadata.fromCache ? "📦 CACHE" : "☁️ SUNUCU";
                        const hasPendingWrites = doc.metadata.hasPendingWrites;

                        console.log(`${source} - Veri alındı (bekleyen yazma: ${hasPendingWrites})`);

                        const data = doc.data();
                        if (data) {
                            // isAdmin'i koru - Firestore'dan gelen isAdmin'i yok say
                            if (data.isAdmin !== undefined) delete data.isAdmin;

                            // State'i güncelle - PAYLAŞILAN VERİLER + Vardiya ayarları
                            // Kişisel filtreler (filterMode, staffFilter vb.) app.localFilters'da
                            app.state = {
                                flights: data.flights || [],
                                shift: data.shift || 'day',
                                customStart: data.customStart || 480,
                                customEnd: data.customEnd || 1200,
                                staff: data.staff || ['AHMET Y.', 'MEHMET K.', 'AYŞE D.', 'FATMA S.', 'CAN B.'],
                                assignments: data.assignments || {},
                                gates: data.gates || {},
                                overrides: data.overrides || {},
                                completed: data.completed || [],
                                delayed: data.delayed || {},
                                timeChanges: data.timeChanges || {},
                                baseDate: data.baseDate || null,
                                history: data.history || [],
                                flightHistory: data.flightHistory || {},
                                lastUpdated: data.lastUpdated || 0 // Çakışma kontrolü için
                            };

                            // UI'ı güncelle
                            app.ui.render();
                            app.ui.renderStaff();
                            app.ui.updateHeaderShiftLabel();
                            app.ui.updateAdminUI(); // Her seferinde admin UI'ı güncelle!

                            // Senkronizasyon bildirimi - sadece sunucudan geldiğinde göster
                            if (!doc.metadata.fromCache && !hasPendingWrites) {
                                const el = document.getElementById('saveStatus');
                                if (el) {
                                    el.style.opacity = '1';
                                    el.innerHTML = '<i class="fa-solid fa-cloud-arrow-down text-blue-400"></i> <span class="text-blue-400">GÜNCELLENDİ</span>';
                                    setTimeout(() => el.style.opacity = '0', 3000);
                                }
                            }

                            console.log(`✅ State güncellendi - ${data.flights?.length || 0} uçuş`);

                            // Admin PIN'i Firestore'dan yükle
                            loadAdminPin();

                            // AirLabs cache'i Firestore'dan yükle (bir kez)
                            if (Object.keys(airLabs.flightCache).length === 0) {
                                airLabs.loadFromFirestore().then(() => {
                                    // Cache yüklendikten sonra kartları yenile (etiketler görünsün)
                                    if (Object.keys(airLabs.flightCache).length > 0) {
                                        app.ui.render();
                                        console.log('🔄 AirLabs: Cache yüklendi, kartlar yenilendi');
                                    }
                                });
                            }
                        } else {
                            console.log('📭 Firestore\'da veri yok, boş başlatılıyor...');
                        }
                    },
                    (err) => {
                        console.error('❌ Firestore listener error:', err);
                        app.ui.toast('Bağlantı hatası - yeniden deniyor...', 'error');
                        // 5 saniye sonra yeniden bağlan
                        setTimeout(() => app.data.load(), 5000);
                    }
                );
                console.log('🔥 Firestore bağlandı - Realtime listener aktif!');
            } else {
                console.warn('⚠️ Firestore bağlantısı yok!');
            }
        },

        saveToJson: () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([JSON.stringify(app.state)], { type: 'application/json' })); a.download = `backup_${Date.now()}.json`; a.click(); },
        loadFromJson: (input) => { const f = input.files[0]; if (!f) return; const r = new FileReader(); r.onload = (e) => { app.state = JSON.parse(e.target.result); if (!app.state.delayed) app.state.delayed = {}; app.ui.render(); app.ui.renderStaff(); app.ui.updateHeaderShiftLabel(); app.data.save(); app.ui.toast("Yedek Yüklendi", "success"); }; r.readAsText(f); },
        reset: () => { airLabs.clearCache(); app.ui.smartReset(); }
    }
};
window.addEventListener('DOMContentLoaded', app.init);
