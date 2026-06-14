importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.7.1/firebase-messaging-compat.js');

// Firebase Configuration for SW
const firebaseConfig = {
    apiKey: "AIzaSyCPWMCjCp45PiTZ-VgskEszobpBzUFaOBk",
    authDomain: "followme-ops.firebaseapp.com",
    projectId: "followme-ops",
    storageBucket: "followme-ops.firebasestorage.app",
    messagingSenderId: "881822008",
    appId: "1:881822008:web:493ddb46ff7c56e2ea59cd"
};

firebase.initializeApp(firebaseConfig);

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
    console.log('[firebase-messaging-sw.js] Arka plan bildirimi (Data) alındı ', payload);
    
    const notificationTitle = payload.data.flightNo || "Yeni Görev";
    const notificationOptions = {
        body: payload.data.message || "Yeni bir bildiriminiz var.",
        icon: './icon-192.png',
        badge: './icon-192.png',
        vibrate: [300, 100, 300, 100, 300, 100, 300], // Uzun ve belirgin titreşim
        requireInteraction: true, // Ekranda asılı kalsın
        tag: `flight-${payload.data.flightNo}`,
        data: payload.data
    };

    self.registration.showNotification(notificationTitle, notificationOptions);
});

// Follow-Me Ops - Service Worker v25.0 - Push Notifications
const CACHE_NAME = 'fm-ops-v46';
const urlsToCache = [
    './',
    './index.html',
    './app.js',
    './styles.css',
    './icon-192.png',
    './icon-512.png'
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => {
                console.log('📦 Caching app files...');
                return cache.addAll(urlsToCache);
            })
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys().then(cacheNames => {
            return Promise.all(
                cacheNames.map(cacheName => {
                    if (cacheName !== CACHE_NAME) {
                        return caches.delete(cacheName);
                    }
                })
            );
        }).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    if (event.request.method !== 'GET') return;
    if (event.request.url.includes('firebase') ||
        event.request.url.includes('googleapis') ||
        event.request.url.includes('gstatic')) {
        return;
    }
    event.respondWith(
        fetch(event.request)
            .then(response => {
                if (response.status === 200) {
                    const responseClone = response.clone();
                    caches.open(CACHE_NAME).then(cache => {
                        cache.put(event.request, responseClone);
                    });
                }
                return response;
            })
            .catch(() => {
                return caches.match(event.request);
            })
    );
});

self.addEventListener('notificationclick', event => {
    event.notification.close();
    event.waitUntil(
        clients.matchAll({ type: 'window' }).then(clientList => {
            for (const client of clientList) {
                if ('focus' in client) return client.focus();
            }
            if (clients.openWindow) return clients.openWindow('/');
        })
    );
});
