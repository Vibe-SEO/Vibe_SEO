
let selectedPlatform = "";
let currentRoom = "";
let currentVideoUrl = "";
let currentRoomName = "";
let roomChannel = null;
let roomPlaybackSeconds = 0;
let roomPlaybackRunning = false;
let roomPlaybackTimer = null;
let roomClientId = Math.random().toString(36).slice(2);
let roomIframe = null;
let roomVkPlayer = null;
let roomRutubeReady = false;
let roomRutubeLastTime = 0;
let roomSocket = null;
let roomSocketHandlersBound = false;

function ensureRoomSocket() {
    if (roomSocket) return roomSocket;
    if (typeof window.io !== "function") {
        console.warn("VIBE: socket.io не загружен");
        return null;
    }
    try {
        const host = (window.location && window.location.hostname) || "";
        const isProxyHost = /github\.dev|githubbox|codespaces|gitpod|loca\.lt|ngrok/i.test(host);
        roomSocket = window.io({
            path: "/socket.io/",
            // На github.dev websocket часто мёртвый — только polling
            transports: isProxyHost ? ["polling"] : ["polling", "websocket"],
            upgrade: !isProxyHost,
            reconnection: true,
            reconnectionAttempts: 12,
            reconnectionDelay: 1000,
            timeout: 15000,
            autoConnect: true,
            forceNew: false
        });
        roomSocket.on("connect_error", function (err) {
            console.warn("VIBE socket connect_error:", err && err.message ? err.message : err);
        });
    } catch (e) {
        console.warn("VIBE socket init:", e);
        try { roomSocket = window.io(); } catch (e2) { roomSocket = null; }
    }
    return roomSocket;
}

// Не блокируем загрузку страницы — подключаемся чуть позже
if (typeof window !== "undefined") {
    window.setTimeout(function () {
        try { ensureRoomSocket(); } catch (e) {}
    }, 50);
}
let roomApplyingRemoteState = false;
let roomPendingSync = null;
let roomParticipants = [];
let roomParticipantsTimer = null;
let moviePlayerLoadTimer = null;
let isRoomHost = false;
let roomVideoLoaded = false;
const isMobileVibe = /Android|iPhone|iPad|iPod|Mobile|IEMobile/i.test(navigator.userAgent || "")
    || (typeof window.matchMedia === "function" && window.matchMedia("(max-width: 820px)").matches);
let lastRemoteApplyAt = 0;
let lastRemotePlayingState = null;
let lastRemoteSeekAt = 0;
let roomForcePausedUntil = 0; // игнор "play" событий от Rutube после паузы
let rutubePauseLockTimer = null;
let roomPlayerReadyAt = 0;
let roomLastLoadedUrl = "";

/* ===== Sync engine (по образцу production room-player) =====
 * - postMessage {type, data} + JSON.stringify
 * - не трогаем iframe.src при синке
 * - mediaReady / expectedPlaying / pendingSeek
 */
const roomPlayerCtl = {
    mediaReady: false,
    expectedPlaying: null, // true|false|null
    expectedPlayingAt: 0,
    pendingSeek: null,
    lastKnownTime: 0,
    lastKnownAt: 0,
    playing: false
};

function resetRoomPlayerCtl() {
    roomPlayerCtl.mediaReady = false;
    roomPlayerCtl.expectedPlaying = null;
    roomPlayerCtl.expectedPlayingAt = 0;
    roomPlayerCtl.pendingSeek = null;
    roomPlayerCtl.lastKnownTime = 0;
    roomPlayerCtl.lastKnownAt = Date.now();
    roomPlayerCtl.playing = false;
}

function rutubePost(type, data) {
    const iframe = roomIframe || (typeof getPlayerIframe === "function" && getPlayerIframe());
    if (!iframe || !iframe.contentWindow) return;
    const payload = { type: type, data: data || {} };
    try { iframe.contentWindow.postMessage(payload, "*"); } catch (e) {}
    try { iframe.contentWindow.postMessage(JSON.stringify(payload), "*"); } catch (e) {}
}

function rutubeCtlSeek(seconds) {
    const t = Math.max(0, Number(seconds) || 0);
    roomPlayerCtl.pendingSeek = t;
    if (!roomPlayerCtl.mediaReady) return;
    rutubePost("player:setCurrentTime", { time: t });
}

function rutubeCtlPlay() {
    roomPlayerCtl.expectedPlaying = true;
    roomPlayerCtl.expectedPlayingAt = Date.now();
    rutubePost("player:play", {});
}

function rutubeCtlPause() {
    roomPlayerCtl.expectedPlaying = false;
    roomPlayerCtl.expectedPlayingAt = Date.now();
    rutubePost("player:pause", {});
}

function rutubeCtlApplyRemote(seconds, wantPlaying) {
    const drift = Math.abs((Number(seconds) || 0) - getCtlCurrentTime());
    // seek только при заметном рассинхроне
    const needSeek = drift > (isMobileVibe ? 6 : 2);
    if (needSeek) rutubeCtlSeek(seconds);
    if (wantPlaying) rutubeCtlPlay();
    else rutubeCtlPause();
}

function getCtlCurrentTime() {
    if (roomPlayerCtl.playing && roomPlayerCtl.lastKnownAt) {
        return roomPlayerCtl.lastKnownTime + (Date.now() - roomPlayerCtl.lastKnownAt) / 1000;
    }
    return roomPlayerCtl.lastKnownTime;
}

function isRutubeMessageOrigin(origin) {
    if (!origin || typeof origin !== "string") return false;
    return origin === "https://rutube.ru"
        || origin.endsWith(".rutube.ru")
        || origin === "https://cdnvideo.ru"
        || origin.endsWith(".cdnvideo.ru");
}

function handleRutubeMessage(payload) {
    if (!payload || typeof payload !== "object") return;
    const type = String(payload.type || "");
    const data = payload.data || {};

    if (type === "player:ready" || type === "player:init") {
        roomPlayerCtl.mediaReady = true;
        if (roomPlayerCtl.pendingSeek != null) {
            rutubePost("player:setCurrentTime", { time: roomPlayerCtl.pendingSeek });
        }
        return;
    }
    if (type === "player:playStart") {
        roomPlayerCtl.mediaReady = true;
        roomPlayerCtl.playing = true;
        roomPlayerCtl.lastKnownAt = Date.now();
        if (roomPlayerCtl.pendingSeek != null) {
            const t = roomPlayerCtl.pendingSeek;
            roomPlayerCtl.pendingSeek = null;
            rutubePost("player:setCurrentTime", { time: t });
        }
        // подтверждение play от плеера
        const recent = Date.now() - roomPlayerCtl.expectedPlayingAt < 2500;
        if (recent && roomPlayerCtl.expectedPlaying === false) {
            // мы хотели паузу — вернуть
            rutubePost("player:pause", {});
            return;
        }
        setPlaybackState(getCtlCurrentTime(), true, isRoomHost && !roomApplyingRemoteState);
        return;
    }
    if (type === "player:playComplete") {
        roomPlayerCtl.playing = false;
        setPlaybackState(getCtlCurrentTime(), false, isRoomHost && !roomApplyingRemoteState);
        return;
    }
    if (type === "player:changeState") {
        const state = data.state;
        if (typeof state !== "string") return;
        const isPlaying = state === "playing";
        const isPaused = state === "paused" || state === "pause" || state === "stopped" || state === "ended" || state === "completed";
        if (!isPlaying && !isPaused) return;
        const recent = Date.now() - roomPlayerCtl.expectedPlayingAt < 2500;
        if (recent && roomPlayerCtl.expectedPlaying !== null && roomPlayerCtl.expectedPlaying !== isPlaying) {
            // игнор эха / конфликт с нашей командой
            if (roomPlayerCtl.expectedPlaying) rutubePost("player:play", {});
            else rutubePost("player:pause", {});
            return;
        }
        roomPlayerCtl.playing = isPlaying;
        roomPlayerCtl.lastKnownAt = Date.now();
        setPlaybackState(getCtlCurrentTime(), isPlaying, isRoomHost && !roomApplyingRemoteState);
        return;
    }
    if (type === "player:currentTime") {
        const t = data.time;
        if (typeof t !== "number" || !Number.isFinite(t)) return;
        roomPlayerCtl.mediaReady = true;
        roomPlayerCtl.lastKnownTime = t;
        roomPlayerCtl.lastKnownAt = Date.now();
        roomPlaybackSeconds = t;
        if (typeof renderPlaybackTime === "function") renderPlaybackTime();
        return;
    }
}



const roomModal = document.getElementById("roomModal");
const createRoomHero = document.getElementById("createRoomHero");
const joinRoomHero = document.getElementById("joinRoomHero");
const closeModal = document.getElementById("closeModal");
const roomStepPlatform = document.getElementById("roomStepPlatform");
const roomStepVideo = document.getElementById("roomStepVideo");
const roomStepReady = document.getElementById("roomStepReady");
const platforms = document.querySelectorAll(".platform");
const videoUrl = document.getElementById("videoUrl");
const roomName = document.getElementById("roomName");
const urlError = document.getElementById("urlError");
const platformDescription = document.getElementById("platformDescription");
const openPlatform = document.getElementById("openPlatform");
const createRoomFinal = document.getElementById("createRoomFinal");
const backToPlatforms = document.getElementById("backToPlatforms");
const generatedRoomCode = document.getElementById("generatedRoomCode");
const createdRoomName = document.getElementById("createdRoomName");
const createdPlatform = document.getElementById("createdPlatform");
const copyRoomCode = document.getElementById("copyRoomCode");
const enterRoom = document.getElementById("enterRoom");
const watchPage = document.getElementById("watchPage");
const backHome = document.getElementById("backHome");
const watchRoomCode = document.getElementById("watchRoomCode");
const watchTimer = document.getElementById("watchTimer");
const peopleCount = document.getElementById("peopleCount");
const watchTitle = document.getElementById("watchTitle");
const watchPlatform = document.getElementById("watchPlatform");
const inviteButton = document.getElementById("inviteButton");
const playButton = document.getElementById("playButton");
const playerPlay = document.getElementById("playerPlay");
const playerProgress = document.getElementById("playerProgress");
const playerMute = document.getElementById("playerMute");
const playerFullscreen = document.getElementById("playerFullscreen");
const chatForm = document.getElementById("chatForm");
const chatInput = document.getElementById("chatInput");
const chatMessages = document.getElementById("chatMessages");
const peopleList = document.querySelector("#watchPage .people-list");
const videoSourceBadge = document.getElementById("videoSourceBadge");

const roomsPage = document.getElementById("roomsPage");
const roomsBack = document.getElementById("roomsBack");
const roomsCreateButton = document.getElementById("roomsCreateButton");
const roomLinkInput = document.getElementById("roomLinkInput");
const roomLinkButton = document.getElementById("roomLinkButton");
const roomLinkError = document.getElementById("roomLinkError");
const homePage = document.getElementById("homePage");
const siteFooter = document.querySelector(".site-footer");
const detailPage = document.getElementById("detailPage");
const detailBack = document.getElementById("detailBack");
const detailBrand = document.getElementById("detailBrand");
const detailPoster = document.getElementById("detailPoster");
const detailKicker = document.getElementById("detailKicker");
const detailTitle = document.getElementById("detailTitle");
const detailOriginalTitle = document.getElementById("detailOriginalTitle");
const detailKp = document.getElementById("detailKp");
const detailImdb = document.getElementById("detailImdb");
const detailDirector = document.getElementById("detailDirector");
const detailYear = document.getElementById("detailYear");
const detailCountry = document.getElementById("detailCountry");
const detailDuration = document.getElementById("detailDuration");
const detailTags = document.getElementById("detailTags");
const detailDescription = document.getElementById("detailDescription");
const detailWatchButton = document.getElementById("detailWatchButton");
const moviePlayerModal = document.getElementById("moviePlayerModal");
const moviePlayerClose = document.getElementById("moviePlayerClose");
const moviePlayerCloseBottom = document.getElementById("moviePlayerCloseBottom");
const moviePlayerArt = document.getElementById("moviePlayerArt");
const moviePlayerTitle = document.getElementById("moviePlayerTitle");
const moviePlayerMeta = document.getElementById("moviePlayerMeta");
const moviePlayerScreenTitle = document.getElementById("moviePlayerScreenTitle");
const moviePlayerScreen = document.querySelector(".movie-player-screen");
const moviePlayerStart = document.getElementById("moviePlayerStart");
const moviePlayerVideo = document.getElementById("moviePlayerVideo");
const roomsBrand = document.getElementById("roomsBrand");
const catalogPage = document.getElementById("catalogPage");
const catalogBack = document.getElementById("catalogBack");
const catalogBrand = document.getElementById("catalogBrand");
const catalogSearch = document.getElementById("catalogSearch");
const catalogGrid = document.getElementById("catalogGrid");
const catalogEmpty = document.getElementById("catalogEmpty");
const catalogCount = document.getElementById("catalogCount");
const catalogFilters = [
    document.getElementById("catalogType"),
    document.getElementById("catalogGenre"),
    document.getElementById("catalogYear"),
    document.getElementById("catalogSort")
];

const mobileRooms = document.getElementById("mobileRooms");
const mobileLogin = document.getElementById("mobileLogin");
const authModal = document.getElementById("authModal");
const authClose = document.getElementById("authClose");
const mobileNavItems = document.querySelectorAll(".mobile-nav-item, .desktop-nav-item, .desktop-nav-login");
const newsModal = document.getElementById("newsModal");
const newsModalClose = document.getElementById("newsModalClose");
const newsFeedbackForm = document.getElementById("newsFeedbackForm");
const newsFeedbackInput = document.getElementById("newsFeedbackInput");

const authSwitch = document.getElementById("authSwitch");
const authTitle = document.getElementById("authTitle");
const authSubtitle = document.getElementById("authSubtitle");
const authPasswordConfirm = document.getElementById("authPasswordConfirm");
const authSubmit = document.getElementById("authSubmit");
let authRegisterMode = false;

function openNewsModal() {
    if (!newsModal) return;
    newsModal.classList.remove("hidden");
    newsModal.setAttribute("aria-hidden", "false");
    document.body.style.overflow = "hidden";
}

function closeNewsModal() {
    if (!newsModal) return;
    newsModal.classList.add("hidden");
    newsModal.setAttribute("aria-hidden", "true");
    document.body.style.overflow = "";
}

if (newsModalClose) newsModalClose.addEventListener("click", closeNewsModal);
if (newsModal) {
    newsModal.addEventListener("click", function (event) {
        if (event.target === newsModal) closeNewsModal();
    });
}
if (newsFeedbackForm) {
    newsFeedbackForm.addEventListener("submit", function (event) {
        event.preventDefault();
        if (!newsFeedbackInput || !newsFeedbackInput.value.trim()) return;
        newsFeedbackInput.value = "";
        newsFeedbackInput.placeholder = "Спасибо за обратную связь!";
    });
}

const quickCreate = document.getElementById("quickCreate");
const quickJoin = document.getElementById("quickJoin");
const openCatalog = document.getElementById("openCatalog");
const featuredMovie = document.querySelector(".featured-movie");
const featuredBackground = document.querySelector(".featured-bg");
const featuredTitle = document.getElementById("featuredTitle");
const featuredDescription = document.getElementById("featuredDescription");
const featuredKp = document.getElementById("featuredKp");
const featuredImdb = document.getElementById("featuredImdb");
const featuredGenre = document.getElementById("featuredGenre");
const featuredYear = document.getElementById("featuredYear");
const featuredDots = document.querySelectorAll(".featured-dots span");
let activeFeaturedTitle = "Человек-паук: Новый день";
let featuredTimer = null;


const SUPABASE_URL = "https://eyeopuiomtuuebgidcow.supabase.co";
const SUPABASE_KEY = "sb_publishable_A7Px99MPvVcbQD-dlHsB-A_8DctMq9l";

const supabaseClient = window.supabase && typeof window.supabase.createClient === "function"
    ? window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY)
    : {
        auth: {
            signUp: async function () {
                return { data: { user: null }, error: { message: "Авторизация временно недоступна в этом браузере." } };
            },
            signInWithPassword: async function () {
                return { data: { user: null }, error: { message: "Авторизация временно недоступна в этом браузере." } };
            },
            signOut: async function () {
                return { error: null };
            }
        }
    };


const accountPage = document.getElementById("accountPage");
const accountBack = document.getElementById("accountBack");
const accountLogout = document.getElementById("accountLogout");
const accountEmail = document.getElementById("accountEmail");

if (authClose && authModal) {
    authClose.addEventListener("click", function () {
        authModal.classList.add("hidden");
    });
}

if (mobileLogin && authModal) {
    mobileLogin.addEventListener("click", function () {
        authModal.classList.remove("hidden");
    });
}

if (authSwitch && authTitle && authSubtitle && authPasswordConfirm && authSubmit) {
    authSwitch.addEventListener("click", function () {
        authRegisterMode = !authRegisterMode;

        if (authRegisterMode) {
            authTitle.textContent = "Создать аккаунт";
            authSubtitle.textContent = "Зарегистрируйтесь в VIBE";
            authPasswordConfirm.classList.remove("hidden");
            authSubmit.textContent = "Зарегистрироваться";
            authSwitch.textContent = "Войти";
        } else {
            authTitle.textContent = "С возвращением";
            authSubtitle.textContent = "Войдите в свой аккаунт VIBE";
            authPasswordConfirm.classList.add("hidden");
            authSubmit.textContent = "Войти";
            authSwitch.textContent = "Зарегистрироваться";
        }
    });
}

if (authSubmit) {
    authSubmit.addEventListener("click", async function () {
        const email = document.getElementById("authEmail").value.trim();
        const password = document.getElementById("authPassword").value;
        const passwordConfirm = document.getElementById("authPasswordConfirm").value;

        if (!email || !password) {
            alert("Введите email и пароль.");
            return;
        }

        if (authRegisterMode) {
            if (password !== passwordConfirm) {
                alert("Пароли не совпадают.");
                return;
            }
            if (password.length < 6) {
                alert("Пароль должен содержать минимум 6 символов.");
                return;
            }

            const { data, error } = await supabaseClient.auth.signUp({
                email: email,
                password: password
            });

            if (error) {
                alert(error.message);
                return;
            }

            if (data.user) {
                authModal.classList.add("hidden");
                accountPage.classList.remove("hidden");
                accountEmail.textContent = data.user.email;
            }
            return;
        }

        const { data, error } = await supabaseClient.auth.signInWithPassword({
            email: email,
            password: password
        });

        if (error) {
            alert(error.message);
            return;
        }

        if (data.user) {
            authModal.classList.add("hidden");
            accountPage.classList.remove("hidden");
            accountEmail.textContent = data.user.email;
        }
    });
}

if (accountBack && accountPage) {
    accountBack.addEventListener("click", function () {
        accountPage.classList.add("hidden");
    });
}

if (accountLogout) {
    accountLogout.addEventListener("click", async function () {
        await supabaseClient.auth.signOut();
        accountPage.classList.add("hidden");
    });
}


function syncFooterVisibility() {
    if (!siteFooter) return;
    const movieModalVisible = !!moviePlayerModal && !moviePlayerModal.classList.contains("hidden");
    const showFooter = (!homePage || !homePage.classList.contains("hidden")) ||
        (!catalogPage || !catalogPage.classList.contains("hidden"));
    siteFooter.style.display = showFooter && !movieModalVisible ? "flex" : "none";
}

function openRoomsPage() {
    if (roomModal) {
        roomModal.classList.remove("show");
        roomModal.setAttribute("aria-hidden", "true");
    }
    if (watchPage) watchPage.classList.add("hidden");
    if (detailPage) detailPage.classList.add("hidden");

    const homePage = document.getElementById("homePage");
    if (homePage) homePage.classList.add("hidden");
    if (catalogPage) catalogPage.classList.add("hidden");

    if (roomsPage) roomsPage.classList.remove("hidden");
    syncFooterVisibility();
    document.body.style.overflow = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function openCatalogPage() {
    if (roomModal) {
        roomModal.classList.remove("show");
        roomModal.setAttribute("aria-hidden", "true");
    }
    if (watchPage) watchPage.classList.add("hidden");
    if (detailPage) detailPage.classList.add("hidden");
    if (roomsPage) roomsPage.classList.add("hidden");

    const homePage = document.getElementById("homePage");
    if (homePage) homePage.classList.add("hidden");
    if (catalogPage) catalogPage.classList.remove("hidden");

    syncFooterVisibility();
    document.body.style.overflow = "";
    window.scrollTo({ top: 0, behavior: "smooth" });
    applyCatalogFilters();
}

const catalogMovies = [
    ["Человек-паук: Новый день", "Spider-Man: Brand New Day", 2026, "Фантастика", "Дестин Дэниел Креттон", "США, Великобритания", "2 ч 30 м", "8.0", "8.1", "sci-fi", "Приключения, боевик"],
    ["1+1", "Intouchables", 2011, "Комедия", "Оливье Накаш, Эрик Толедано", "Франция", "1 ч 52 м", "8.9", "8.5", "comedy", "Драма"],
    ["Твоя вина: Лондон", "Your Fault: London", 2025, "Драма", "Даниэль Кальпарсоро", "Великобритания", "1 ч 58 м", "7.8", "6.9", "drama", "Мелодрама"],
    ["Майкл", "Michael", 2025, "Драма", "Антуан Фукуа", "США", "1 ч 58 м", "8.1", "7.0", "drama", "Музыка, биография"],
    ["Холод", "The Cold", 2025, "Триллер", "VIBE Studio", "США", "1 ч 46 м", "7.7", "6.8", "thriller", "Драма"],
    ["Дюна: Часть вторая", "Dune: Part Two", 2024, "Фантастика", "Дени Вильнёв", "США, Канада", "2 ч 46 м", "8.7", "8.6", "sci-fi", "Приключения, драма"],
    ["Оппенгеймер", "Oppenheimer", 2023, "Драма", "Кристофер Нолан", "США, Великобритания", "3 ч", "8.6", "8.6", "drama", "Биография, история"],
    ["Барби", "Barbie", 2023, "Комедия", "Грета Гервиг", "США, Великобритания", "1 ч 54 м", "7.8", "6.8", "comedy", "Фэнтези, комедия"],
    ["Гладиатор 2", "Gladiator II", 2024, "Боевик", "Ридли Скотт", "США, Великобритания", "2 ч 28 м", "7.8", "6.5", "action", "Драма, приключения"],
    ["Фуриоса: Хроники Безумного Макса", "Furiosa: A Mad Max Saga", 2024, "Боевик", "Джордж Миллер", "США, Австралия", "2 ч 28 м", "8.0", "7.5", "action", "Фантастика, приключения"],
    ["Веном: Последний танец", "Venom: The Last Dance", 2024, "Боевик", "Келли Марсел", "США, Великобритания", "1 ч 49 м", "7.6", "6.0", "action", "Фантастика"],
    ["Дэдпул и Росомаха", "Deadpool & Wolverine", 2024, "Боевик", "Шон Леви", "США", "2 ч 8 м", "8.2", "7.6", "action", "Комедия, фантастика"],
    ["Головоломка 2", "Inside Out 2", 2024, "Анимация", "Келси Манн", "США", "1 ч 36 м", "8.3", "7.6", "animation", "Комедия, семейный"],
    ["Гадкий я 4", "Despicable Me 4", 2024, "Анимация", "Крис Рено", "США", "1 ч 34 м", "7.2", "6.1", "animation", "Комедия, семейный"],
    ["Моана 2", "Moana 2", 2024, "Анимация", "Дэвид Деррик-младший", "США", "1 ч 40 м", "7.6", "6.4", "animation", "Приключения, семейный"],
    ["Дикий робот", "The Wild Robot", 2024, "Анимация", "Крис Сандерс", "США", "1 ч 42 м", "8.7", "8.2", "animation", "Приключения, драма"],
    ["ВАЛЛИ-И", "WALL-E", 2008, "Анимация", "Эндрю Стэнтон", "США", "1 ч 38 м", "8.9", "8.4", "animation", "Фантастика, семейный"],
    ["Изгоняющий дьявола: Верующие", "The Exorcist: Believer", 2023, "Ужасы", "Дэвид Гордон Грин", "США", "1 ч 51 м", "6.8", "4.8", "horror", "Триллер"],
    ["Улыбка 2", "Smile 2", 2024, "Ужасы", "Паркер Финн", "США", "2 ч 7 м", "7.5", "6.5", "horror", "Триллер"],
    ["Еретик", "Heretic", 2024, "Триллер", "Скотт Бек, Брайан Вудс", "США", "1 ч 51 м", "7.8", "7.0", "thriller", "Ужасы, драма"],
    ["Субстанция", "The Substance", 2024, "Ужасы", "Корали Фаржа", "Великобритания, Франция", "2 ч 21 м", "7.8", "7.3", "horror", "Драма, фантастика"],
    ["Гражданская война", "Civil War", 2024, "Боевик", "Алекс Гарленд", "США, Великобритания", "1 ч 49 м", "7.8", "7.0", "action", "Триллер, драма"],
    ["Падение империи", "Kingdom of the Planet of the Apes", 2024, "Фантастика", "Уэс Болл", "США", "2 ч 25 м", "7.7", "6.9", "sci-fi", "Боевик, приключения"],
    ["Планета обезьян: Новое царство", "Kingdom of the Planet of the Apes", 2024, "Фантастика", "Уэс Болл", "США", "2 ч 25 м", "7.7", "6.9", "sci-fi", "Боевик, приключения"],
    ["Миссия невыполнима: Финальная расплата", "Mission: Impossible - The Final Reckoning", 2025, "Боевик", "Кристофер Маккуорри", "США", "2 ч 49 м", "8.0", "7.2", "action", "Триллер, приключения"],
    ["F1", "F1", 2025, "Боевик", "Джозеф Косински", "США", "2 ч 35 м", "8.2", "7.8", "action", "Драма, спорт"],
    ["Супермен", "Superman", 2025, "Фантастика", "Джеймс Ганн", "США", "2 ч 9 м", "8.0", "7.5", "sci-fi", "Боевик, приключения"],
    ["Фантастическая четвёрка: Первые шаги", "The Fantastic Four: First Steps", 2025, "Фантастика", "Мэтт Шекман", "США", "1 ч 55 м", "8.0", "7.3", "sci-fi", "Боевик, драма"],
    ["Громовержцы*", "Thunderbolts*", 2025, "Боевик", "Джейк Шрейер", "США", "2 ч 6 м", "8.0", "7.5", "action", "Фантастика"],
    ["Minecraft в кино", "A Minecraft Movie", 2025, "Приключения", "Джаред Хесс", "США, Швеция", "1 ч 41 м", "7.4", "5.8", "adventure", "Фэнтези, комедия"],
    ["Как приручить дракона", "How to Train Your Dragon", 2025, "Приключения", "Дин ДеБлуа", "США", "2 ч 5 м", "8.0", "7.8", "adventure", "Фэнтези, семейный"],
    ["Баллада о маленьком игроке", "The Ballad of a Small Player", 2025, "Драма", "Эдвард Бергер", "Великобритания", "1 ч 41 м", "7.4", "6.8", "drama", "Триллер"],
    ["Анора", "Anora", 2024, "Драма", "Шон Бейкер", "США", "2 ч 19 м", "8.0", "7.7", "drama", "Комедия, мелодрама"],
    ["Конклав", "Conclave", 2024, "Триллер", "Эдвард Бергер", "Великобритания, США", "2 ч", "8.0", "7.4", "thriller", "Драма, детектив"],
    ["Боб Дилан: Никому не известный", "A Complete Unknown", 2024, "Драма", "Джеймс Мэнголд", "США", "2 ч 20 м", "7.8", "7.4", "drama", "Биография, музыка"],
    ["Омерзительная пятёрка", "The Ministry of Ungentlemanly Warfare", 2024, "Боевик", "Гай Ричи", "США, Великобритания", "2 ч", "7.8", "6.8", "action", "Комедия, война"],
    ["Каскадёры", "The Fall Guy", 2024, "Боевик", "Дэвид Литч", "США", "2 ч 6 м", "7.9", "6.8", "action", "Комедия, мелодрама"],
    ["Достать ножи: Проснись, мертвец", "Wake Up Dead Man: A Knives Out Mystery", 2025, "Триллер", "Райан Джонсон", "США", "2 ч 15 м", "8.0", "7.4", "thriller", "Детектив, драма"],
    ["Лило и Стич", "Lilo & Stitch", 2025, "Приключения", "Дин Флейшер Кэмп", "США", "1 ч 48 м", "7.8", "7.2", "adventure", "Комедия, семейный"],
    ["Бэтмен", "The Batman", 2022, "Боевик", "Мэтт Ривз", "США", "2 ч 56 м", "8.2", "7.8", "action", "Драма, криминал"],
    ["Социальная сеть", "The Social Network", 2010, "Драма", "Дэвид Финчер", "США", "2 ч", "8.0", "7.8", "drama", "Биография, история"],
    ["Социальная расплата", "The Accountant 2", 2025, "Боевик", "Гэвин О'Коннор", "США", "2 ч 4 м", "7.8", "6.8", "action", "Триллер"],
    ["Социальная дилемма", "The Social Dilemma", 2020, "Документальный", "Джефф Орловски", "США", "1 ч 34 м", "7.7", "7.6", "drama", "Документальный"]
];

const movieDetails = {};
const kinopoiskIconMarkup = "<svg class=\"rating-kp-svg\" viewBox=\"0 0 24 24\" fill=\"currentColor\" aria-label=\"КиноПоиск\"><path d=\"M12.049 0C5.45 0 .104 5.373.104 12S5.45 24 12.049 24c3.928 0 7.414-1.904 9.592-4.844l-9.803-5.174 6.256 6.418h-3.559l-4.373-6.086V20.4h-2.89V3.6h2.89v6.095L14.535 3.6h3.559l-6.422 6.627 9.98-5.368C19.476 1.911 15.984 0 12.05 0zm10.924 7.133-9.994 4.027 10.917-.713a11.963 11.963 0 0 0-.923-3.314zm-10.065 5.68 10.065 4.054c.458-1.036.774-2.149.923-3.314l-10.988-.74z\"></path></svg>";
const localPosters = {
    "Человек-паук: Новый день": "poster1.png",
    "Одиссея": "poster2.png",
    "Тёмный рыцарь": "poster3.png",
    "Интерстеллар": "poster4.png",
    "1+1": "poster5.png",
    "Падение империи": "Снимок экрана 2026-09-21 041457.png"
    ,"Гладиатор 2": "Снимок экрана 2026-09-21 040753.png"
    ,"Веном: Последний танец": "Снимок экрана 2026-09-21 040808.png"
    ,"Дэдпул и Росомаха": "Снимок экрана 2026-09-21 040825.png"
    ,"Головоломка 2": "Снимок экрана 2026-09-21 040840.png"
    ,"Гадкий я 4": "Снимок экрана 2026-09-21 040856.png"
    ,"Моана 2": "Снимок экрана 2026-09-21 041004.png"
    ,"Дикий робот": "Снимок экрана 2026-09-21 041028.png"
    ,"ВАЛЛИ-И": "Снимок экрана 2026-09-21 041050.png"
    ,"Изгоняющий дьявола: Верующие": "Снимок экрана 2026-09-21 041113.png"
    ,"Улыбка 2": "Снимок экрана 2026-09-21 041209.png"
    ,"Еретик": "Снимок экрана 2026-09-21 041316.png"
    ,"Субстанция": "Снимок экрана 2026-09-21 041344.png"
    ,"Фуриоса: Хроники Безумного Макса": "Снимок экрана 2026-09-21 042735.png"
    ,"Миссия невыполнима: Финальная расплата": "Снимок экрана 2026-09-21 042810.png"
    ,"Супермен": "Снимок экрана 2026-09-21 042836.png"
    ,"Фантастическая четвёрка: Первые шаги": "Снимок экрана 2026-09-21 042855.png"
    ,"Боб Дилан: Никому не известный": "Снимок экрана 2026-09-21 042914.png"
    ,"Каскадёры": "Снимок экрана 2026-09-21 042932.png"
    ,"Достать ножи: Проснись, мертвец": "Снимок экрана 2026-09-21 043028.png"
    ,"Лило и Стич": "Снимок экрана 2026-09-21 043042.png"
    ,"Социальная сеть": "Снимок экрана 2026-09-21 043108.png"
    ,"Социальная расплата": "Снимок экрана 2026-09-21 043151.png"
    ,"Социальная дилемма": "Снимок экрана 2026-09-21 043207.png"
    ,"Планета обезьян: Новое царство": "Снимок экрана 2026-09-21 044620.png"
    ,"F1": "Снимок экрана 2026-09-21 044648.png"
    ,"Minecraft в кино": "Снимок экрана 2026-09-21 044706.png"
    ,"Громовержцы*": "Снимок экрана 2026-09-21 044724.png"
    ,"Как приручить дракона": "Снимок экрана 2026-09-21 044752.png"
    ,"Баллада о маленьком игроке": "Снимок экрана 2026-09-21 044807.png"
    ,"Анора": "Снимок экрана 2026-09-21 044828.png"
    ,"Конклав": "Снимок экрана 2026-09-21 044837.png"
    ,"Омерзительная пятёрка": "Снимок экрана 2026-09-21 044857.png"
    ,"Бэтмен": "Снимок экрана 2026-09-21 044927.png"
    ,"Твоя вина: Лондон": "poster_youfauly.png"
    ,"Майкл": "michael_poster.png"
    ,"Холод": "xolod_poster.png"
    ,"Дюна: Часть вторая": "Снимок экрана 2026-09-22 123639.png"
    ,"Барби": "Снимок экрана 2026-09-22 123704.png"
    ,"Оппенгеймер": "Снимок экрана 2026-09-22 123724.png"
    ,"Гражданская война": "Снимок экрана 2026-09-21 050355.png"
};

function getLocalPosterUrl(title) {
    return localPosters[title]
        ? encodeURI("images/" + localPosters[title])
        : "";
}

function createLocalPoster(title, year, genre, index) {
    const palette = ["#32145f", "#123d5b", "#5a202d", "#174d4a", "#51351a", "#30234c"];
    const safeTitle = title.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const titleParts = safeTitle.match(/.{1,18}(?:\s|$)/g) || [safeTitle];
    const titleLines = titleParts.slice(0, 4).map(function (line, lineIndex) {
        return "<text x=\"34\" y=\"" + (420 + lineIndex * 34) + "\" class=\"title\">" + line.trim() + "</text>";
    }).join("");
    const svg = "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"600\" height=\"900\" viewBox=\"0 0 600 900\"><defs><linearGradient id=\"bg\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop stop-color=\"" + palette[index % palette.length] + "\"/><stop offset=\"1\" stop-color=\"#0b0714\"/></linearGradient><filter id=\"glow\"><feGaussianBlur stdDeviation=\"45\"/></filter></defs><rect width=\"600\" height=\"900\" fill=\"url(#bg)\"/><circle cx=\"480\" cy=\"210\" r=\"170\" fill=\"#a855f7\" opacity=\".22\" filter=\"url(#glow)\"/><path d=\"M0 650 Q220 520 600 650 V900 H0Z\" fill=\"#07050d\" opacity=\".8\"/><text x=\"34\" y=\"58\" class=\"meta\">VIBE / " + String(year) + "</text><text x=\"34\" y=\"96\" class=\"genre\">" + genre.toUpperCase() + "</text>" + titleLines + "<style>.meta{fill:#d7c8ff;font:700 18px Arial;letter-spacing:3px}.genre{fill:#ffb35c;font:700 15px Arial;letter-spacing:2px}.title{fill:#fff;font:900 30px Arial;letter-spacing:1px}</style></svg>";
    return "data:image/svg+xml;charset=UTF-8," + encodeURIComponent(svg);
}

catalogMovies.forEach(function (movie, index) {
    const title = movie[0];
    const tags = [movie[3].toLowerCase()].concat(movie[10] ? movie[10].split(", ").map(function (tag) { return tag.toLowerCase(); }) : []);
    movieDetails[title] = {
        original: movie[1], poster: "catalog-poster-" + index, type: "ФИЛЬМ", kp: movie[7], imdb: movie[8],
        director: movie[4], year: String(movie[2]), country: movie[5], duration: movie[6], tags: tags,
        description: "Популярный фильм " + movie[2] + " года о героях, которым приходится сделать сложный выбор и пройти испытание, меняющее их жизнь.",
        posterUrl: getLocalPosterUrl(title) || createLocalPoster(title, movie[2], movie[3], index),
        videoUrl: title === "Человек-паук: Новый день"
            ? "videos/video_spider_man.mp4"
            : movie[11] || ""
    };
});

const movieIndex = catalogMovies.map(function (movie) {
    return {
        title: movie[0], original: movie[1], year: String(movie[2]), type: "Фильм",
        genre: movie[3], kp: movie[7], imdb: movie[8], posterUrl: movieDetails[movie[0]].posterUrl
    };
});

function searchMovieDatabase(query) {
    const normalizedQuery = query.trim().toLocaleLowerCase("ru");
    if (!normalizedQuery) return [];
    return movieIndex.filter(function (movie) {
        return (movie.title + " " + movie.original + " " + movie.genre)
            .toLocaleLowerCase("ru")
            .includes(normalizedQuery);
    }).slice(0, 8);
}

function renderSearchResults(input, resultsElement) {
    if (!input || !resultsElement) return;
    const results = searchMovieDatabase(input.value);
    resultsElement.innerHTML = "";
    if (!input.value.trim()) {
        resultsElement.classList.remove("is-visible");
        return;
    }

    if (!results.length) {
        const empty = document.createElement("p");
        empty.className = "search-results-empty";
        empty.textContent = "Фильм не найден";
        resultsElement.appendChild(empty);
    } else {
        results.forEach(function (movie) {
            const result = document.createElement("button");
            result.type = "button";
            result.className = "search-result";
            result.dataset.movieTitle = movie.title;

            const poster = document.createElement("span");
            poster.className = "search-result-poster";
            poster.style.backgroundImage = "url('" + movie.posterUrl + "')";

            const content = document.createElement("span");
            content.className = "search-result-content";
            const title = document.createElement("strong");
            title.textContent = movie.title;
            const meta = document.createElement("small");
            meta.textContent = movie.year + " · " + movie.type;

            const ratings = document.createElement("span");
            ratings.className = "search-result-ratings";
            ratings.innerHTML = "<span class=\"catalog-rating-kp\">" + kinopoiskIconMarkup + "<strong>" + movie.kp + "</strong></span><span class=\"catalog-rating-imdb\"><b class=\"rating-imdb-icon\">IMDb</b><strong>" + movie.imdb + "</strong></span>";

            content.appendChild(title);
            content.appendChild(meta);
            result.appendChild(poster);
            result.appendChild(content);
            result.appendChild(ratings);
            resultsElement.appendChild(result);
        });
    }
    resultsElement.classList.add("is-visible");
}

function setupDatabaseSearch() {
    document.querySelectorAll("input[placeholder='Поиск по названию']").forEach(function (input) {
        const resultsElement = input.parentElement.querySelector(".search-results");
        if (!resultsElement) return;
        input.addEventListener("focus", function () {
            renderSearchResults(input, resultsElement);
        });
        input.addEventListener("input", function () {
            renderSearchResults(input, resultsElement);
        });
        resultsElement.addEventListener("click", function (event) {
            const result = event.target.closest(".search-result");
            if (!result) return;
            input.value = result.dataset.movieTitle;
            resultsElement.classList.remove("is-visible");
            openMovieDetails(result.dataset.movieTitle);
        });
    });
}

function renderCatalog() {
    if (!catalogGrid) return;
    catalogGrid.innerHTML = "";
    catalogMovies.forEach(function (movie, index) {
        const card = document.createElement("article");
        card.className = "catalog-card";
        card.dataset.type = "movie";
        card.dataset.genre = movie[9];
        card.dataset.year = String(movie[2]);
        card.dataset.rating = movie[7];
        card.dataset.popularity = String(index + 1);
        card.dataset.title = movie[0].toLowerCase();
        card.dataset.original = movie[1].toLowerCase();
        card.dataset.movieTitle = movie[0];

        const poster = document.createElement("div");
        poster.className = "catalog-poster";
        poster.style.backgroundImage = "url('" + movieDetails[movie[0]].posterUrl + "')";
        poster.innerHTML = "<div class=\"catalog-rating\"><span class=\"catalog-rating-kp\">" + kinopoiskIconMarkup + "<strong>" + movie[7] + "</strong></span><span class=\"catalog-rating-imdb\"><b class=\"rating-imdb-icon\">IMDb</b><strong>" + movie[8] + "</strong></span></div>";

        const title = document.createElement("h2");
        title.textContent = movie[0];
        const category = document.createElement("span");
        category.className = "catalog-category";
        category.textContent = movie[3] + (movie[10] ? " · " + movie[10].split(", ")[0] : "");
        const facts = document.createElement("p");
        facts.textContent = movie[2] + " · " + movie[5];

        card.appendChild(poster);
        card.appendChild(title);
        card.appendChild(category);
        card.appendChild(facts);
        catalogGrid.appendChild(card);
    });
}

function applyHomeMoviePosters() {
    document.querySelectorAll(".movie-card").forEach(function (card) {
        const titleElement = card.querySelector(".movie-title");
        const posterElement = card.querySelector(".movie-poster");
        const details = titleElement ? movieDetails[titleElement.textContent.trim()] : null;
        if (posterElement && details) {
            posterElement.style.setProperty("background-image", "url('" + details.posterUrl + "')", "important");
            posterElement.style.backgroundSize = "cover";
            posterElement.style.backgroundPosition = "center";
        }
    });
}

const featuredSlides = [
    {
        title: "Человек-паук: Новый день",
        desktopImage: "images/posterNEWDAY.png",
        mobileImage: "images/poster1.png",
        description: "Одинокий и повзрослевший Питер Паркер полностью посвящает себя борьбе с преступностью.",
        genre: "фантастика",
        year: "2026"
    },
    {
        title: "Твоя вина: Лондон",
        desktopImage: "images/posterYOURFOULT.png",
        mobileImage: "images/poster_youfauly.png",
        description: "Новая история любви, в которой расстояние, ошибки прошлого и большой город проверяют чувства героев.",
        genre: "драма",
        year: "2025"
    }
];

function setFeaturedSlide(index, restartTimer) {
    if (!featuredMovie || !featuredSlides[index]) return;
    const slide = featuredSlides[index];
    activeFeaturedTitle = slide.title;
    featuredMovie.dataset.slide = String(index);
    if (featuredBackground) {
        const image = window.matchMedia("(min-width: 1024px)").matches
            ? slide.desktopImage
            : slide.mobileImage;
        featuredBackground.style.opacity = "0";
        featuredBackground.style.setProperty("background-image", "url('" + image + "')", "important");
        window.requestAnimationFrame(function () {
            featuredBackground.style.opacity = "1";
        });
    }
    if (featuredTitle) {
        const titleParts = slide.title.split(": ");
        featuredTitle.innerHTML = titleParts.length > 1
            ? titleParts[0] + ":<br><span class=\"accent\">" + titleParts[1] + "</span>"
            : slide.title;
    }
    if (featuredDescription) featuredDescription.textContent = slide.description;
    if (featuredGenre) featuredGenre.textContent = slide.genre;
    if (featuredYear) featuredYear.textContent = slide.year;
    if (featuredKp) featuredKp.textContent = slide.kp || "8.0";
    if (featuredImdb) featuredImdb.textContent = slide.imdb || "7.8";
    featuredDots.forEach(function (dot, dotIndex) {
        dot.classList.toggle("active", dotIndex === index);
    });
    if (restartTimer) {
        clearInterval(featuredTimer);
        featuredTimer = setInterval(function () {
            setFeaturedSlide((index + 1) % featuredSlides.length, false);
        }, 6000);
    }
}

featuredDots.forEach(function (dot, index) {
    dot.addEventListener("click", function () {
        if (window.matchMedia("(min-width: 1024px)").matches) return;
        setFeaturedSlide(index, true);
    });
    dot.addEventListener("keydown", function (event) {
        if (window.matchMedia("(min-width: 1024px)").matches) return;
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            setFeaturedSlide(index, true);
        }
    });
});

if (featuredMovie) {
    let touchStartX = 0;
    featuredMovie.addEventListener("touchstart", function (event) {
        touchStartX = event.changedTouches[0].clientX;
    }, { passive: true });
    featuredMovie.addEventListener("touchend", function (event) {
        if (window.matchMedia("(min-width: 1024px)").matches) return;
        const distance = event.changedTouches[0].clientX - touchStartX;
        if (Math.abs(distance) < 45) return;
        const direction = distance < 0 ? 1 : -1;
        const currentIndex = Number(featuredMovie.dataset.slide || 0);
        setFeaturedSlide((currentIndex + direction + featuredSlides.length) % featuredSlides.length, true);
    }, { passive: true });
}

const desktopFeatured = window.matchMedia("(min-width: 1024px)").matches;
setFeaturedSlide(desktopFeatured ? 1 : 0, !desktopFeatured);
function openMovieDetails(title) {
    const details = movieDetails[title] || movieDetails[catalogMovies[0][0]];
    if (!detailPage) return;

    document.querySelectorAll(".search-results.is-visible").forEach(function (resultsElement) {
        resultsElement.classList.remove("is-visible");
    });
    document.querySelectorAll("input[placeholder='Поиск по названию']").forEach(function (input) {
        input.blur();
    });
    if (homePage) homePage.classList.add("hidden");
    if (catalogPage) catalogPage.classList.add("hidden");
    if (roomsPage) roomsPage.classList.add("hidden");
    if (watchPage) watchPage.classList.add("hidden");
    if (roomModal) roomModal.classList.remove("show");

    detailPage.classList.remove("hidden");
    syncFooterVisibility();
    document.body.style.overflow = "";
    detailPage.dataset.poster = details.poster;
    detailTitle.textContent = title;
    detailOriginalTitle.textContent = details.original;
    detailKicker.textContent = details.type;
    detailKp.textContent = details.kp;
    detailImdb.textContent = details.imdb;
    detailDirector.textContent = details.director;
    detailYear.textContent = details.year;
    detailCountry.textContent = details.country;
    detailDuration.textContent = details.duration;
    detailDescription.textContent = details.description;
    detailPoster.className = "detail-poster " + details.poster;
    detailPoster.style.backgroundImage = "url('" + details.posterUrl + "')";
    detailTags.innerHTML = details.tags.map(function (tag) {
        return "<span>" + tag + "</span>";
    }).join("");
    document.title = "VIBE — " + title;
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeMovieDetails() {
    if (detailPage) detailPage.classList.add("hidden");
    if (homePage) homePage.classList.remove("hidden");
    syncFooterVisibility();
    document.title = "VIBE — Смотри вместе";
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeCatalogPage() {
    if (catalogPage) catalogPage.classList.add("hidden");

    const homePage = document.getElementById("homePage");
    if (homePage) homePage.classList.remove("hidden");

    syncFooterVisibility();
    document.body.style.overflow = "";
    document.title = "VIBE — Смотри вместе";
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function closeRoomsPage() {
    if (roomsPage) roomsPage.classList.add("hidden");

    const homePage = document.getElementById("homePage");
    if (homePage) homePage.classList.remove("hidden");

    syncFooterVisibility();
    document.body.style.overflow = "";
    document.title = "VIBE — Смотри вместе";
    window.scrollTo({ top: 0, behavior: "smooth" });
}

function openMoviePlayer(title) {
    const details = movieDetails[title];
    if (!details || !moviePlayerModal) return;

    moviePlayerModal.classList.remove("hidden");
    moviePlayerModal.setAttribute("aria-hidden", "false");
    syncFooterVisibility();
    document.body.style.overflow = "hidden";

    if (moviePlayerArt) moviePlayerArt.style.backgroundImage = "url('" + details.posterUrl + "')";
    if (moviePlayerTitle) moviePlayerTitle.textContent = title;
    if (moviePlayerMeta) moviePlayerMeta.textContent = details.year + " · " + details.original;
    if (moviePlayerScreenTitle) moviePlayerScreenTitle.textContent = title;

    window.activeMovieTitle = title;
    setMoviePlayerSource("vibix");
}

const movieEmbedIds = {
    "Человек-паук: Новый день": "tt22084616", // Поставили рабочий ID вместо пустого 2026 года!
    "1+1": "tt1675434",
    "Интерстеллар": "tt0816692",
    "Тёмный рыцарь": "tt0468569"
};

function setMoviePlayerSource(sourceType) {
    const iframe = document.getElementById("movieModalIframe");
    if (!iframe) return;

    const movieId = movieEmbedIds[window.activeMovieTitle] || "tt0816692";
    const source = String(sourceType || "alloha").toLowerCase();
    const loading = document.getElementById("moviePlayerLoading");
    const sourceUrls = {
        alloha: "https://vidsrc.pm/embed/movie/" + movieId,
        turbo: "https://2embed.skin/embed/" + movieId,
        vibix: "https://2embed.skin/embed/" + movieId
    };

    if (moviePlayerLoadTimer) window.clearTimeout(moviePlayerLoadTimer);
    if (loading) {
        loading.textContent = "Загрузка плеера...";
        loading.classList.remove("is-hidden");
    }
    iframe.onload = function () {
        if (moviePlayerLoadTimer) window.clearTimeout(moviePlayerLoadTimer);
        if (loading) loading.classList.add("is-hidden");
    };
    iframe.src = sourceUrls[source] || sourceUrls.alloha;

    moviePlayerLoadTimer = window.setTimeout(function () {
        if (source !== "vibix") {
            setMoviePlayerSource("vibix");
            return;
        }
        if (loading) {
            loading.textContent = "Источник видео временно недоступен. Выберите другой источник.";
            loading.classList.remove("is-hidden");
        }
    }, 12000);

    document.querySelectorAll("#moviePlayerModal .source-tab").forEach(function (tab) {
        tab.classList.toggle("active", tab.textContent.trim().toLowerCase() === source);
    });
}

function closeMoviePlayer() {
    if (!moviePlayerModal) return;
    moviePlayerModal.classList.add("hidden");
    moviePlayerModal.setAttribute("aria-hidden", "true");
    if (moviePlayerVideo) moviePlayerVideo.pause();
    const iframe = document.getElementById("movieModalIframe");
    if (moviePlayerLoadTimer) window.clearTimeout(moviePlayerLoadTimer);
    if (iframe) {
        iframe.onload = null;
        iframe.src = "";
    }
    syncFooterVisibility();
    document.body.style.overflow = "";
}

function leaveRoomSocket() {
    if (roomSocket && roomSocket.connected && currentRoom) {
        roomSocket.emit("room:leave");
    }
    if (roomParticipantsTimer) {
        window.clearInterval(roomParticipantsTimer);
        roomParticipantsTimer = null;
    }
    roomParticipants = [];
    isRoomHost = false;
    roomVideoLoaded = false;
    roomPlaybackSeconds = 0;
    roomPlaybackRunning = false;
    if (roomPlaybackTimer) {
        clearInterval(roomPlaybackTimer);
        roomPlaybackTimer = null;
    }
}


if (createRoomHero) {
    createRoomHero.addEventListener("click", function () {
        openMoviePlayer(activeFeaturedTitle);
    });
}

if (joinRoomHero) {
    joinRoomHero.addEventListener("click", function () {
        openMovieDetails(activeFeaturedTitle);
    });
}

if (detailBack) detailBack.addEventListener("click", closeMovieDetails);
if (detailBrand) detailBrand.addEventListener("click", function (event) {
    event.preventDefault();
    closeMovieDetails();
});
if (roomsBrand) roomsBrand.addEventListener("click", function (event) {
    event.preventDefault();
    closeRoomsPage();
});
if (detailWatchButton) detailWatchButton.addEventListener("click", function () {
    openMoviePlayer(detailTitle ? detailTitle.textContent.trim() : "");
});
if (moviePlayerClose) moviePlayerClose.addEventListener("click", closeMoviePlayer);
if (moviePlayerCloseBottom) moviePlayerCloseBottom.addEventListener("click", closeMoviePlayer);
if (moviePlayerModal) moviePlayerModal.addEventListener("click", function (event) {
    if (event.target === moviePlayerModal) closeMoviePlayer();
});
if (moviePlayerStart) moviePlayerStart.addEventListener("click", function () {
    if (moviePlayerVideo && moviePlayerVideo.src) {
        moviePlayerVideo.play();
    } else if (moviePlayerScreen) {
        moviePlayerScreen.querySelector("span").textContent = "Для просмотра нужен лицензированный источник видео";
    }
});

document.querySelectorAll(".movie-card").forEach(function (card) {
    const titleElement = card.querySelector(".movie-title");
    if (!titleElement) return;
    card.addEventListener("click", function () {
        openMovieDetails(titleElement.textContent.trim());
    });
});

if (catalogGrid) {
    catalogGrid.addEventListener("click", function (event) {
        const card = event.target.closest(".catalog-card");
        if (card && card.dataset.movieTitle) openMovieDetails(card.dataset.movieTitle);
    });
}

if (quickCreate) {
    quickCreate.addEventListener("click", openRoomsPage);
}

if (quickJoin) {
    quickJoin.addEventListener("click", openRoomsPage);
}

if (openCatalog) {
    openCatalog.addEventListener("click", function () {
        openCatalogPage();
    });
}

if (catalogBack) {
    catalogBack.addEventListener("click", closeCatalogPage);
}

function applyCatalogFilters() {
    if (!catalogGrid) return;

    const type = document.getElementById("catalogType");
    const genre = document.getElementById("catalogGenre");
    const year = document.getElementById("catalogYear");
    const sort = document.getElementById("catalogSort");
    const searchQuery = catalogSearch ? catalogSearch.value.trim().toLowerCase() : "";
    const cards = Array.from(catalogGrid.querySelectorAll(".catalog-card"));

    cards.forEach(function (card) {
        const matchesType = !type || type.value === "all" || card.dataset.type === type.value;
        const matchesGenre = !genre || genre.value === "all" || card.dataset.genre === genre.value;
        const matchesYear = !year || year.value === "all" || card.dataset.year === year.value || (year.value === "2020" && Number(card.dataset.year) >= 2020);
        const matchesSearch = !searchQuery || card.dataset.title.includes(searchQuery) || card.dataset.original.includes(searchQuery);
        card.hidden = !(matchesType && matchesGenre && matchesYear && matchesSearch);
    });

    cards.sort(function (first, second) {
        if (sort && sort.value === "rating") return Number(second.dataset.rating) - Number(first.dataset.rating);
        if (sort && sort.value === "newest") return Number(second.dataset.year) - Number(first.dataset.year);
        return Number(first.dataset.popularity) - Number(second.dataset.popularity);
    });
    cards.forEach(function (card) { catalogGrid.appendChild(card); });

    const visibleCount = cards.filter(function (card) { return !card.hidden; }).length;
    if (catalogCount) catalogCount.textContent = visibleCount + " " + (visibleCount === 1 ? "фильм" : "фильмов");
    if (catalogEmpty) catalogEmpty.classList.toggle("hidden", visibleCount > 0);
}

catalogFilters.forEach(function (filter) {
    if (filter) filter.addEventListener("change", applyCatalogFilters);
});

if (catalogSearch) {
    catalogSearch.addEventListener("input", applyCatalogFilters);
}

if (catalogBrand) {
    catalogBrand.addEventListener("click", function (event) {
        event.preventDefault();
        closeCatalogPage();
    });
}

renderCatalog();
applyHomeMoviePosters();
setupDatabaseSearch();
syncFooterVisibility();

document.addEventListener("click", function (event) {
    if (event.target.closest(".header-search, .catalog-search, .detail-search, .rooms-search, .watch-search")) return;
    document.querySelectorAll(".search-results.is-visible").forEach(function (resultsElement) {
        resultsElement.classList.remove("is-visible");
    });
});


function openRoomModal() {
    if (!roomModal) return;
    roomModal.classList.add("show");
    roomModal.setAttribute("aria-hidden", "false");
    resetRoomModal();
}

if (roomsCreateButton) {
    roomsCreateButton.addEventListener("click", openRoomModal);
}

function closeRoomModal() {
    if (!roomModal) return;
    roomModal.classList.remove("show");
    roomModal.setAttribute("aria-hidden", "true");
}

if (closeModal) {
    closeModal.addEventListener("click", closeRoomModal);
}

if (roomModal) {
    roomModal.addEventListener("click", function (event) {
        if (event.target === roomModal) closeRoomModal();
    });
}

function resetRoomModal() {
    selectedPlatform = "";
    if (roomStepPlatform) roomStepPlatform.classList.remove("hidden");
    if (roomStepVideo) roomStepVideo.classList.add("hidden");
    if (roomStepReady) roomStepReady.classList.add("hidden");

    platforms.forEach(function (platform) {
        platform.classList.remove("selected");
    });

    if (videoUrl) videoUrl.value = "";
    if (roomName) roomName.value = "";
    if (urlError) urlError.textContent = "";
}


platforms.forEach(function (platform) {
    platform.addEventListener("click", function () {
        selectedPlatform = platform.dataset.platform;

        platforms.forEach(function (item) {
            item.classList.remove("selected");
        });
        platform.classList.add("selected");

        if (roomStepPlatform) roomStepPlatform.classList.add("hidden");
        if (roomStepVideo) roomStepVideo.classList.remove("hidden");
        updatePlatformDescription();
    });
});

function updatePlatformDescription() {
    if (!platformDescription) return;

    if (selectedPlatform === "youtube") {
        platformDescription.textContent = "Найдите фильм или видео на YouTube и вставьте ссылку сюда.";
    } else if (selectedPlatform === "vk") {
        platformDescription.textContent = "Найдите фильм или видео в VK Видео и вставьте ссылку сюда.";
    } else if (selectedPlatform === "rutube") {
        platformDescription.textContent = "Найдите фильм или видео на RUTUBE и вставьте ссылку сюда.";
    } else {
        platformDescription.textContent = "Найдите видео и вставьте его ссылку.";
    }
}

if (openPlatform) {
    openPlatform.addEventListener("click", function () {
        let url = "";
        if (selectedPlatform === "youtube") url = "https://www.youtube.com/";
        if (selectedPlatform === "vk") url = "https://vk.com/video";
        if (selectedPlatform === "rutube") url = "https://rutube.ru/";
        if (url) window.open(url, "_blank", "noopener,noreferrer");
    });
}

if (backToPlatforms) {
    backToPlatforms.addEventListener("click", function () {
        selectedPlatform = "";
        if (roomStepVideo) roomStepVideo.classList.add("hidden");
        if (roomStepPlatform) roomStepPlatform.classList.remove("hidden");
        platforms.forEach(function (platform) {
            platform.classList.remove("selected");
        });
        if (urlError) urlError.textContent = "";
    });
}


function validateVideoUrl(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();

        if (selectedPlatform === "youtube") {
            return (
                host === "youtube.com" ||
                host === "www.youtube.com" ||
                host === "m.youtube.com" ||
                host === "youtu.be" ||
                host === "www.youtu.be"
            );
        }
        if (selectedPlatform === "vk") {
            return (
                host === "vk.com" ||
                host.endsWith(".vk.com") ||
                host === "vkvideo.ru" ||
                host.endsWith(".vkvideo.ru")
            );
        }
        if (selectedPlatform === "rutube") {
            return host === "rutube.ru" || host.endsWith(".rutube.ru");
        }
        return false;
    } catch (error) {
        return false;
    }
}

function getYouTubeVideoId(url) {
    try {
        const parsed = new URL(url);
        const host = parsed.hostname.toLowerCase();

        if (
            (host === "youtube.com" || host === "www.youtube.com" || host === "m.youtube.com") &&
            parsed.searchParams.get("v")
        ) {
            return parsed.searchParams.get("v");
        }
        if (host === "youtu.be" || host === "www.youtu.be") {
            return parsed.pathname.replace(/^\/+/, "").split("/")[0];
        }
        if (host.includes("youtube.com") && parsed.pathname.startsWith("/shorts/")) {
            return parsed.pathname.split("/")[2];
        }
        if (host.includes("youtube.com") && parsed.pathname.startsWith("/embed/")) {
            return parsed.pathname.split("/")[2];
        }
    } catch (error) {
        console.error("VIBE YouTube URL error:", error);
    }
    return null;
}

function generateRoomCode() {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let result = "VIBE-";
    for (let i = 0; i < 4; i++) {
        result += chars[Math.floor(Math.random() * chars.length)];
    }
    return result;
}

function getPlatformName(platform) {
    if (platform === "youtube") return "YouTube";
    if (platform === "vk") return "VK Видео";
    if (platform === "rutube") return "RUTUBE";
    return "Видео";
}

if (createRoomFinal) {
    createRoomFinal.addEventListener("click", function () {
        const url = videoUrl ? videoUrl.value.trim() : "";
        const name = roomName && roomName.value.trim() ? roomName.value.trim() : "Вечер кино";

        if (!selectedPlatform) {
            if (urlError) urlError.textContent = "Сначала выберите сервис.";
            return;
        }
        if (!url) {
            if (urlError) urlError.textContent = "Вставьте ссылку на видео.";
            return;
        }
        if (!validateVideoUrl(url)) {
            if (urlError) urlError.textContent = "Ссылка не соответствует выбранному сервису.";
            return;
        }

        currentRoom = generateRoomCode();
        currentVideoUrl = normalizeVideoSource(selectedPlatform, url);
        currentRoomName = name;

        const roomData = {
            code: currentRoom,
            platform: selectedPlatform,
            videoUrl: currentVideoUrl,
            name: currentRoomName,
            createdAt: Date.now()
        };

        localStorage.setItem("vibe_room_" + currentRoom, JSON.stringify(roomData));

        const showCreatedRoom = function () {
            if (generatedRoomCode) generatedRoomCode.textContent = currentRoom;
            if (createdRoomName) createdRoomName.textContent = currentRoomName;
            if (createdPlatform) createdPlatform.textContent = getPlatformName(selectedPlatform);
            if (roomStepVideo) roomStepVideo.classList.add("hidden");
            if (roomStepReady) roomStepReady.classList.remove("hidden");
        };

        ensureRoomSocket();
        if (roomSocket) {
            roomSocket.emit("room:create", roomData, function (response) {
                if (!response || !response.ok) {
                    if (urlError) urlError.textContent = response && response.error ? response.error : "Не удалось создать комнату.";
                    return;
                }
                isRoomHost = true;
                showCreatedRoom();
            });
        } else {
            isRoomHost = true;
            showCreatedRoom();
        }
    });
}

if (copyRoomCode) {
    copyRoomCode.addEventListener("click", async function () {
        if (!currentRoom) return;
        const text = getRoomLink() || currentRoom;
        try {
            await navigator.clipboard.writeText(text);
            copyRoomCode.textContent = "Ссылка скопирована ✓";
            setTimeout(function () {
                copyRoomCode.textContent = "Копировать";
            }, 1800);
        } catch (error) {
            prompt("Скопируйте ссылку комнаты:", text);
        }
    });
}

if (enterRoom) {
    enterRoom.addEventListener("click", function () {
        closeRoomModal();
        openWatchRoom();
    });
}

function getRoomLink() {
    if (!currentRoom) return "";
    const params = new URLSearchParams({
        room: currentRoom,
        platform: selectedPlatform,
        video: currentVideoUrl,
        name: currentRoomName
    });
    return window.location.origin + window.location.pathname + "?" + params.toString();
}


function openWatchRoom() {
    if (!watchPage) {
        console.error("VIBE: watchPage не найден.");
        return;
    }

    const homePage = document.getElementById("homePage");
    if (homePage) homePage.classList.add("hidden");
    if (roomsPage) roomsPage.classList.add("hidden");
    if (catalogPage) catalogPage.classList.add("hidden");
    if (detailPage) detailPage.classList.add("hidden");

    watchPage.classList.remove("hidden");
    document.body.style.overflow = "hidden";
    // Сразу убрать всё, что может глушить тапы на мобиле
    window.setTimeout(function () {
        hideVibePlaceholder();
        setGuestPlayerInteractive(true);
        document.querySelectorAll("#vibeGuestBlock").forEach(function (el) { el.remove(); });
    }, 0);

    const playerSection = watchPage.querySelector(".player-section");
    if (playerSection) {
        const playerSectionChildren = Array.from(playerSection.children);
        playerSection.replaceChildren();
        playerSectionChildren.forEach(function (child) {
            playerSection.appendChild(child);
        });
    }

    if (watchRoomCode) watchRoomCode.textContent = currentRoom;

    if (typeof currentVideoUrl !== 'undefined' && currentVideoUrl && (currentVideoUrl.includes("vk.com") || currentVideoUrl.includes("vkvideo.ru"))) {
        selectedPlatform = "vk";
    }

    if (watchTitle) watchTitle.textContent = currentRoomName || "Вечер кино";
    if (watchPlatform) watchPlatform.textContent = getPlatformName(selectedPlatform);

    document.title = "VIBE — " + (currentRoomName || "Комната");
    addSystemMessage("Вы вошли в комнату.");

    // Подтянуть platform/video из URL (главный путь для гостя по ссылке)
    try {
        const params = new URLSearchParams(window.location.search);
        if (params.get("room")) {
            currentRoom = params.get("room").trim().toUpperCase();
        }
        if (params.get("video")) {
            const p = params.get("platform") || selectedPlatform || detectPlatformFromUrl(params.get("video"));
            selectedPlatform = p || selectedPlatform;
            currentVideoUrl = normalizeVideoSource(selectedPlatform || detectPlatformFromUrl(params.get("video")), params.get("video"));
            if (!selectedPlatform) selectedPlatform = detectPlatformFromUrl(currentVideoUrl);
            currentRoomName = params.get("name") || currentRoomName || "Вечер кино";
        }
    } catch (e) {
        console.warn("VIBE URL parse:", e);
    }

    if (!selectedPlatform && currentVideoUrl) {
        selectedPlatform = detectPlatformFromUrl(currentVideoUrl);
    }

    if (watchTitle) watchTitle.textContent = currentRoomName || "Вечер кино";
    if (watchPlatform) watchPlatform.textContent = getPlatformName(selectedPlatform) || selectedPlatform || "…";

    ensureRoomSocket();
    startRoomChannel();

    if (currentVideoUrl) {
        const key = selectedPlatform + "|" + currentVideoUrl;
        if (roomLastLoadedUrl !== key) {
            roomVideoLoaded = false;
        }
        // Сразу грузим плеер — без вечной заглушки «Загрузка…»
        loadRoomVideo();
    } else {
        window.setTimeout(function () {
            if (!currentVideoUrl) {
                showVideoError("Нет ссылки на видео. Попросите хоста нажать «Поделиться комнатой».");
            }
        }, 6000);
    }
}


function detectPlatformFromUrl(url) {
    const value = String(url || "").toLowerCase();
    if (!value) return "";
    if (value.includes("youtube.com") || value.includes("youtu.be")) return "youtube";
    if (value.includes("rutube.ru")) return "rutube";
    if (value.includes("vk.com") || value.includes("vkvideo.ru")) return "vk";
    return "";
}

function getRutubeVideoId(url) {
    // KinoParty: только 32 hex, video / video/private / play/embed
    const value = String(url || "").trim();
    if (!value) return "";
    let match = value.match(/rutube\.ru\/(?:video(?:\/private)?|play\/embed)\/([0-9a-f]{32})/i);
    if (match) return match[1].toLowerCase();
    match = value.match(/^([0-9a-f]{32})$/i);
    if (match) return match[1].toLowerCase();
    match = value.match(/(?:play\/embed|video(?:\/private)?)\/([0-9a-f]{32})/i);
    if (match) return match[1].toLowerCase();
    return "";
}

function parseVkVideoIds(url) {
    const value = String(url || "").trim();
    if (!value) return null;

    // Уже embed: video_ext.php?oid=...&id=...
    try {
        if (value.includes("video_ext.php")) {
            const parsed = new URL(value.replace("vkvideo.ru", "vk.com"));
            const oid = parsed.searchParams.get("oid");
            const id = parsed.searchParams.get("id");
            const hash = parsed.searchParams.get("hash") || "";
            if (oid && id) return { oid: String(oid), id: String(id), hash: String(hash) };
        }
    } catch (e) {}

    // z=video-123_456 или z=clip-123_456
    try {
        const parsed = new URL(value);
        const z = parsed.searchParams.get("z") || "";
        const zMatch = z.match(/(?:video|clip)(-?\d+)_(\d+)/i);
        if (zMatch) {
            return {
                oid: zMatch[1],
                id: zMatch[2],
                hash: parsed.searchParams.get("hash") || ""
            };
        }
        const hash = parsed.searchParams.get("hash") || "";
        const pathMatch = (parsed.pathname + parsed.search + parsed.hash).match(/(?:video|clip)(-?\d+)_(\d+)/i);
        if (pathMatch) {
            return { oid: pathMatch[1], id: pathMatch[2], hash: hash };
        }
    } catch (e) {}

    // Прямой вид: video-123_456 / clip123_456
    const match = value.match(/(?:video|clip)(-?\d+)_(\d+)/i);
    if (match) {
        let hash = "";
        try {
            hash = new URL(value).searchParams.get("hash") || "";
        } catch (e) {}
        return { oid: match[1], id: match[2], hash: hash };
    }
    return null;
}

function normalizeVideoSource(platform, url) {
    const value = String(url || "").trim();
    if (!value) return "";
    if (platform === "youtube") {
        const videoId = getYouTubeVideoId(value);
        return videoId ? "https://www.youtube.com/watch?v=" + encodeURIComponent(videoId) : value;
    }
    if (platform === "rutube") {
        const videoId = getRutubeVideoId(value);
        return videoId ? "https://rutube.ru/video/" + videoId + "/" : value;
    }
    if (platform === "vk") {
        const ids = parseVkVideoIds(value);
        if (ids) {
            // Канонический короткий вид — на сервер и в localStorage
            let canonical = "https://vk.com/video" + ids.oid + "_" + ids.id;
            if (ids.hash) canonical += "?hash=" + encodeURIComponent(ids.hash);
            return canonical;
        }
        return value.replace("https://vkvideo.ru", "https://vk.com");
    }
    return value.replace("https://vkvideo.ru", "https://vk.com");
}

function getVkVideoEmbedUrl(url) {
    const ids = parseVkVideoIds(url);
    if (!ids) return "";
    // KinoParty: video_ext.php?oid=&id=&hd=2&js_api=1
    let embedUrl = "https://vk.com/video_ext.php?oid=" + encodeURIComponent(ids.oid)
        + "&id=" + encodeURIComponent(ids.id)
        + "&hd=2&js_api=1";
    if (ids.hash) {
        embedUrl += "&hash=" + encodeURIComponent(ids.hash);
    }
    return embedUrl;
}

function loadRoomVideo() {
    const placeholder = document.querySelector(".video-placeholder");
    if (!placeholder) {
        console.error("VIBE: .video-placeholder не найден.");
        return;
    }
    if (!currentVideoUrl) {
        showVideoError("Не удалось определить видео.");
        return;
    }
    // Не перезагружаем тот же ролик — на телефоне это даёт чёрный экран
    const loadKey = selectedPlatform + "|" + currentVideoUrl;
    if (roomVideoLoaded && roomLastLoadedUrl === loadKey) {
        const existing = getPlayerIframe();
        if (existing && existing.src && existing.src.indexOf("http") === 0) {
            roomIframe = existing;
            existing.classList.remove("hidden");
            existing.style.setProperty("display", "block", "important");
            existing.style.setProperty("visibility", "visible", "important");
            existing.style.setProperty("opacity", "1", "important");
            existing.style.setProperty("z-index", "5", "important");
            hideVibePlaceholder();
            return;
        }
        // src пустой — грузим заново
        roomVideoLoaded = false;
    }
    roomVideoLoaded = true;
    roomLastLoadedUrl = loadKey;
    roomPlayerReadyAt = 0;
    const prevIframe = getPlayerIframe();
    if (prevIframe) delete prevIframe.dataset.vibePlayBootstrapped;
    roomIframe = null;
    roomVkPlayer = null;
    roomRutubeReady = false;
    roomRutubeLastTime = 0;
    resetRoomPlayerCtl();

    if (!selectedPlatform) {
        selectedPlatform = detectPlatformFromUrl(currentVideoUrl);
    }
    if (currentVideoUrl.includes("vk.com") || currentVideoUrl.includes("vkvideo.ru")) {
        selectedPlatform = "vk";
    }
    if (currentVideoUrl.includes("rutube.ru")) {
        selectedPlatform = "rutube";
    }
    if (currentVideoUrl.includes("youtube.com") || currentVideoUrl.includes("youtu.be")) {
        selectedPlatform = "youtube";
    }

    if (videoSourceBadge) {
        videoSourceBadge.textContent = getPlatformName(selectedPlatform) + " · официальный плеер";
        videoSourceBadge.classList.remove("hidden");
    }

    if (selectedPlatform === "vk") {
        mountVkPlayer(placeholder);
        return;
    }

    const iframe = getPlayerIframe() || document.createElement("iframe");
    const origin = encodeURIComponent(window.location.origin);

    hideVibePlaceholder();
    if (moviePlayerLoadTimer) window.clearTimeout(moviePlayerLoadTimer);
    // На ПК иногда load-событие iframe не приходит — принудительно показываем
    function forceShowPlayer() {
        const fr = getPlayerIframe() || roomIframe;
        if (!fr) return;
        fr.classList.remove("hidden");
        fr.style.setProperty("display", "block", "important");
        fr.style.setProperty("visibility", "visible", "important");
        fr.style.setProperty("opacity", "1", "important");
        fr.style.setProperty("z-index", "5", "important");
        fr.style.setProperty("pointer-events", "auto", "important");
        hideVibePlaceholder();
    }
    moviePlayerLoadTimer = window.setTimeout(forceShowPlayer, 1500);
    window.setTimeout(forceShowPlayer, 4000);

    if (selectedPlatform === "youtube") {
        const youtubeId = getYouTubeVideoId(currentVideoUrl);
        if (!youtubeId) {
            showVideoError("Не удалось определить YouTube-видео.");
            return;
        }
        iframe.src = "https://www.youtube.com/embed/" + encodeURIComponent(youtubeId) + "?autoplay=1&mute=1&controls=1&rel=0&playsinline=1&enablejsapi=1&origin=" + origin;
    } else if (selectedPlatform === "rutube") {
        const rutubeId = getRutubeVideoId(currentVideoUrl);
        // mobile: mute+autoplay+playsinline — иначе часто 1 кадр и чёрный экран
        iframe.src = rutubeId
            ? ("https://rutube.ru/play/embed/" + rutubeId + "?js_api=1&autoplay=1&mute=1&playsInline=1")
            : currentVideoUrl;
    } else {
        iframe.src = currentVideoUrl;
    }

    iframe.classList.remove("hidden");
    iframe.title = "VIBE — " + getPlatformName(selectedPlatform);
    iframe.allow = "accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share";
    iframe.allowFullscreen = true;
    iframe.loading = "eager";
    iframe.referrerPolicy = "strict-origin-when-cross-origin";
    iframe.style.cssText = "position:absolute;inset:0;z-index:5;width:100%;height:100%;border:0;display:block;background:#000;pointer-events:auto;";

    if (!iframe.parentElement && placeholder) {
        const root = placeholder.closest(".video-player") || placeholder;
        root.appendChild(iframe);
    }

    roomIframe = iframe;
    // Скрываем весь UI VIBE поверх плеера — только нативный YouTube/Rutube/VK
    document.querySelectorAll("#watchPage .player-controls, #vibeStartOverlay, #playButton").forEach(function (el) {
        el.style.setProperty("display", "none", "important");
        el.style.setProperty("pointer-events", "none", "important");
    });

    iframe.addEventListener("load", function () {
        iframe.dataset.vibeLoaded = "1";
        hideVibePlaceholder();
        iframe.classList.remove("hidden");
        iframe.style.cssText = "position:absolute;inset:0;z-index:5;width:100%;height:100%;border:0;display:block;background:#000;pointer-events:auto;";
        roomPlayerReadyAt = Date.now();
        listenToYouTubePlayer();
        listenToRutubePlayer();
        if (selectedPlatform === "rutube") {
            roomRutubeReady = true;
            // js_api: запросить состояние
            rutubePost("player:getCurrentTime", {});
            rutubePost("player:getDuration", {});
        }
        setGuestPlayerInteractive(true);
        // Мягкий sync только UI — без seek/reload
        if (roomPendingSync) {
            const pending = roomPendingSync;
            roomPendingSync = null;
            roomPlaybackSeconds = Number(pending.position || pending.seconds) || 0;
            roomPlaybackRunning = Boolean(pending.playing);
            // postMessage play/pause один раз, без смены src
            window.setTimeout(function () {
                if (selectedPlatform === "youtube") {
                    sendYouTubeCommand(pending.playing ? "playVideo" : "pauseVideo");
                    if (pending.position) sendYouTubeCommand("seekTo", [Number(pending.position) || 0, true]);
                } else if (selectedPlatform === "rutube") {
                    sendRutubeCommand(pending.playing ? "player:play" : "player:pause");
                }
            }, isMobileVibe ? 800 : 300);
        }
    }, { once: true });
}

function sendRutubeCommand(command, data) {
    if (selectedPlatform !== "rutube") return;
    rutubePost(command, data || {});
}

function rutubeForcePause() {
    if (selectedPlatform !== "rutube") return;
    roomForcePausedUntil = Date.now() + 2000;
    rutubeCtlPause();
}

function rutubeForcePlay(seconds) {
    if (selectedPlatform !== "rutube") return;
    roomForcePausedUntil = 0;
    const t = Math.max(0, Number(seconds) || roomPlaybackSeconds || 0);
    rutubeCtlSeek(t);
    rutubeCtlPlay();
}

function setGuestPlayerInteractive(canControl) {
    const iframe = getPlayerIframe && getPlayerIframe();
    if (iframe) {
        iframe.style.setProperty("pointer-events", "auto", "important");
        iframe.style.setProperty("z-index", "5", "important");
    }
    const block = document.getElementById("vibeGuestBlock");
    if (block) block.remove();
    const startBtn = document.getElementById("vibeStartOverlay");
    if (startBtn) startBtn.remove();
    document.querySelectorAll("#watchPage .player-controls").forEach(function (el) {
        el.style.setProperty("display", "none", "important");
    });
    hideVibePlaceholder();
}

function listenToRutubePlayer() {
    if (selectedPlatform !== "rutube") return;
    // как в production: ждём player:ready / currentTime; fallback mediaReady
    rutubePost("player:getDuration", {});
    rutubePost("player:getCurrentTime", {});
    window.setTimeout(function () {
        if (selectedPlatform === "rutube" && !roomPlayerCtl.mediaReady) {
            roomPlayerCtl.mediaReady = true;
            roomRutubeReady = true;
            if (roomPlayerCtl.pendingSeek != null) {
                rutubePost("player:setCurrentTime", { time: roomPlayerCtl.pendingSeek });
            }
            if (roomPendingSync) {
                const pending = roomPendingSync;
                roomPendingSync = null;
                applyRemotePlayback(pending, false);
            }
        }
    }, 2000);
}

/** VK sync без VideoPlayer API: пересобираем embed URL */
let vkEmbedReloadTimer = null;
function syncVkViaEmbedReload(seconds, playing) {
    // KinoParty-style: НЕ перезагружаем embed для синка — только VK.VideoPlayer API
    return;
    if (!roomIframe || selectedPlatform !== "vk") return;
    if (isMobileVibe) return;
    const ids = parseVkVideoIds(currentVideoUrl);
    if (!ids) return;
    let src = "https://vk.com/video_ext.php?oid=" + encodeURIComponent(ids.oid)
        + "&id=" + encodeURIComponent(ids.id)
        + "&hd=2&js_api=1"
        + "&t=" + Math.max(0, Math.floor(seconds)) + "s";
    if (ids.hash) src += "&hash=" + encodeURIComponent(ids.hash);
    if (playing) src += "&autoplay=1";
    src += "&muted=0";
    // debounce — не дёргать iframe каждые 100мс
    if (vkEmbedReloadTimer) window.clearTimeout(vkEmbedReloadTimer);
    vkEmbedReloadTimer = window.setTimeout(function () {
        if (!roomIframe) return;
        if (roomIframe.src !== src) {
            roomIframe.src = src;
        }
        hideVibePlaceholder();
        roomIframe.classList.remove("hidden");
        roomIframe.style.display = "block";
    }, 200);
}

function hideVibePlaceholder() {
    const placeholder = document.getElementById("vibePlaceholder") || document.querySelector(".video-placeholder");
    if (!placeholder) return;
    placeholder.style.setProperty("display", "none", "important");
    placeholder.style.setProperty("visibility", "hidden", "important");
    placeholder.style.setProperty("pointer-events", "none", "important");
    placeholder.style.setProperty("z-index", "0", "important");
    placeholder.style.setProperty("opacity", "0", "important");
    placeholder.classList.add("is-hidden");
    // на всякий случай — любые абсолютные оверлеи кроме iframe/кнопок
    const root = placeholder.closest(".video-player") || document.querySelector("#watchPage .video-player");
    if (root) {
        root.querySelectorAll(".video-placeholder, #vibeGuestBlock").forEach(function (el) {
            el.style.setProperty("pointer-events", "none", "important");
            el.style.setProperty("display", "none", "important");
        });
    }
}

function showVibePlaceholder() {
    const placeholder = document.getElementById("vibePlaceholder") || document.querySelector(".video-placeholder");
    if (!placeholder) return;
    placeholder.style.removeProperty("display");
    placeholder.style.removeProperty("visibility");
    placeholder.style.removeProperty("pointer-events");
    placeholder.style.setProperty("z-index", "2", "important");
    placeholder.classList.remove("is-hidden");
}

function getPlayerIframe() {
    let iframe = document.getElementById("vibePlayerIframe");
    if (!iframe) {
        iframe = document.querySelector("#watchPage .video-player iframe");
    }
    return iframe;
}

function mountVkPlayer(placeholder) {
    const vkEmbedUrl = getVkVideoEmbedUrl(currentVideoUrl);
    if (!vkEmbedUrl || vkEmbedUrl.indexOf("video_ext.php") === -1) {
        showVideoError("Не удалось определить VK Видео. Вставьте ссылку вида https://vk.com/video-123_456");
        return;
    }

    const iframe = getPlayerIframe();
    if (!iframe) {
        showVideoError("Плеер не найден на странице.");
        return;
    }

    // Заглушка НЕ должна перекрывать видео (это была причина чёрного экрана)
    hideVibePlaceholder();

    // Чистим возможные старые динамические iframe внутри placeholder
    if (placeholder) {
        placeholder.querySelectorAll("iframe").forEach(function (node) {
            node.remove();
        });
    }

    let src = vkEmbedUrl;
    // Первый показ: autoplay muted (политика браузера). Синк дальше только через API.
    if (src.indexOf("autoplay=") === -1) src += "&autoplay=1";
    if (src.indexOf("muted=") === -1) src += "&muted=1";

    iframe.classList.remove("hidden");
    iframe.style.cssText = "position:absolute;inset:0;width:100%;height:100%;border:0;z-index:5;display:block;background:#000;";
    iframe.setAttribute("allow", "autoplay; encrypted-media; fullscreen; picture-in-picture");
    iframe.setAttribute("allowfullscreen", "true");
    iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");

    roomIframe = iframe;
    roomVkPlayer = null;

    // Перезагрузка src только если изменился
    if (iframe.src !== src) {
        iframe.src = src;
    }

    function bindVkApi() {
        if (!window.VK || typeof window.VK.VideoPlayer !== "function") {
            console.warn("VIBE: VK.VideoPlayer API нет — управление через кнопки VIBE ограничено.");
            if (roomPendingSync) {
                const pending = roomPendingSync;
                roomPendingSync = null;
                applyRemotePlayback(pending);
            }
            return;
        }
        try {
            const player = window.VK.VideoPlayer(iframe);
            roomVkPlayer = player;
            if (player && typeof player.on === "function") {
                player.on("inited", function () {
                    if (roomPendingSync) {
                        const pending = roomPendingSync;
                        roomPendingSync = null;
                        applyRemotePlayback(pending);
                    }
                });
                player.on("timeupdate", function (event) {
                    const seconds = typeof event === "number" ? event : Number(event && (event.time || event.currentTime));
                    if (!Number.isNaN(seconds)) {
                        roomPlaybackSeconds = seconds;
                        renderPlaybackTime();
                    }
                });
                player.on("play", function () {
                    setPlaybackState(roomPlaybackSeconds, true, isRoomHost && !roomApplyingRemoteState);
                });
                player.on("pause", function () {
                    setPlaybackState(roomPlaybackSeconds, false, isRoomHost && !roomApplyingRemoteState);
                });
                player.on("ended", function () {
                    setPlaybackState(roomPlaybackSeconds, false, isRoomHost && !roomApplyingRemoteState);
                });
            }
            if (roomPendingSync) {
                const pending = roomPendingSync;
                roomPendingSync = null;
                window.setTimeout(function () {
                    applyRemotePlayback(pending);
                }, 500);
            }
        } catch (err) {
            console.warn("VIBE VK bind error:", err);
        }
    }

    iframe.addEventListener("load", function onVkLoad() {
        hideVibePlaceholder();
        window.setTimeout(bindVkApi, 400);
    }, { once: true });

    // На случай если load уже произошёл
    window.setTimeout(function () {
        hideVibePlaceholder();
        bindVkApi();
    }, 800);

    if (!window.VK || typeof window.VK.VideoPlayer !== "function") {
        let tries = 0;
        const waitVk = window.setInterval(function () {
            tries += 1;
            if ((window.VK && typeof window.VK.VideoPlayer === "function") || tries > 25) {
                window.clearInterval(waitVk);
                bindVkApi();
            }
        }, 200);
    }
}

function formatPlaybackTime(seconds) {
    const totalSeconds = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(totalSeconds / 60);
    const remainder = totalSeconds % 60;
    return String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0");
}

function renderPlaybackTime() {
    if (watchTimer) watchTimer.textContent = formatPlaybackTime(roomPlaybackSeconds);
    const playerTime = document.querySelector("#watchPage .player-time");
    if (playerTime) playerTime.textContent = formatPlaybackTime(roomPlaybackSeconds);
    if (playerProgress && roomIframe) {
        const duration = Number(playerProgress.dataset.duration) || 0;
        const percent = duration > 0 ? Math.min(100, roomPlaybackSeconds / duration * 100) : 0;
        playerProgress.value = String(percent);
        playerProgress.style.background = "linear-gradient(90deg, #a855f7 0%, #a855f7 " + percent + "%, rgba(255, 255, 255, 0.18) " + percent + "% )";
    }
}

function setPlaybackState(seconds, isPlaying, shouldBroadcast) {
    roomPlaybackSeconds = Math.max(0, Number(seconds) || 0);
    roomPlaybackRunning = Boolean(isPlaying);
    renderPlaybackTime();
    if (playerPlay) playerPlay.textContent = roomPlaybackRunning ? "Ⅱ" : "▶";

    if (roomPlaybackTimer) clearInterval(roomPlaybackTimer);
    if (roomPlaybackRunning) {
        // На телефоне реже обновляем UI — меньше лагов
        const tickMs = isMobileVibe ? 1000 : 250;
        const tickSec = isMobileVibe ? 1 : 0.25;
        roomPlaybackTimer = setInterval(function () {
            roomPlaybackSeconds += tickSec;
            renderPlaybackTime();
        }, tickMs);
    }

    if (shouldBroadcast && isRoomHost) {
        const playback = {
            position: roomPlaybackSeconds,
            playing: roomPlaybackRunning
        };
        if (roomSocket && roomSocket.connected) {
            roomSocket.emit("room:playback", playback);
        } else if (roomChannel) {
            roomChannel.send({
                type: "broadcast",
                event: "playback",
                payload: { seconds: roomPlaybackSeconds, playing: roomPlaybackRunning }
            });
        }
    }
}

function applyRemotePlayback(payload, force) {
    if (!payload) return;

    const elapsed = payload.playing && payload.updatedAt
        ? Math.max(0, (Date.now() - Number(payload.updatedAt)) / 1000)
        : 0;
    const seconds = (Number(payload.position ?? payload.seconds) || 0) + elapsed;
    const wantPlaying = Boolean(payload.playing);
    const drift = Math.abs(seconds - roomPlaybackSeconds);
    const playingChanged = lastRemotePlayingState === null || lastRemotePlayingState !== wantPlaying;

    const driftThreshold = isMobileVibe ? 8 : 1.5;
    const minSeekInterval = isMobileVibe ? 8000 : 800;
    const now = Date.now();

    // Rutube: единый ctl (как в production) — без раннего return только UI
    if (selectedPlatform === "rutube") {
        lastRemotePlayingState = wantPlaying;
        roomPlaybackSeconds = seconds;
        roomPlaybackRunning = wantPlaying;
        rutubeCtlApplyRemote(seconds, wantPlaying);
        window.setTimeout(function () { roomApplyingRemoteState = false; }, 800);
        return;
    }

    // Мягкое обновление таймера без seek
    if (!force && !playingChanged && drift < driftThreshold) {
        roomPlaybackSeconds = seconds;
        roomPlaybackRunning = wantPlaying;
        renderPlaybackTime();
        if (playerPlay) playerPlay.textContent = wantPlaying ? "Ⅱ" : "▶";
        return;
    }

    // Throttle тяжёлых seek на телефоне
    if (!force && !playingChanged && (now - lastRemoteSeekAt) < minSeekInterval) {
        roomPlaybackSeconds = seconds;
        roomPlaybackRunning = wantPlaying;
        renderPlaybackTime();
        return;
    }

    lastRemoteApplyAt = now;
    lastRemoteSeekAt = now;
    lastRemotePlayingState = wantPlaying;
    roomApplyingRemoteState = true;

    const rutubeWaiting = selectedPlatform === "rutube" && !roomRutubeReady;
    roomPendingSync = roomIframe && !rutubeWaiting ? null : { position: seconds, playing: wantPlaying };
    setPlaybackState(seconds, wantPlaying, false);

    if (selectedPlatform === "youtube" && roomIframe) {
        sendYouTubeCommand("seekTo", [seconds, true]);
        sendYouTubeCommand(wantPlaying ? "playVideo" : "pauseVideo");
    }

    if (selectedPlatform === "vk") {
        let apiOk = false;
        if (roomVkPlayer) {
            try {
                if (typeof roomVkPlayer.seek === "function") {
                    roomVkPlayer.seek(seconds);
                    apiOk = true;
                } else if (typeof roomVkPlayer.setCurrentTime === "function") {
                    roomVkPlayer.setCurrentTime(seconds);
                    apiOk = true;
                }
                if (wantPlaying) {
                    if (typeof roomVkPlayer.play === "function") roomVkPlayer.play();
                    else if (typeof roomVkPlayer.playVideo === "function") roomVkPlayer.playVideo();
                } else {
                    if (typeof roomVkPlayer.pause === "function") roomVkPlayer.pause();
                    else if (typeof roomVkPlayer.pauseVideo === "function") roomVkPlayer.pauseVideo();
                }
            } catch (e) {
                apiOk = false;
            }
        }
        // На телефоне reload embed только при play/pause или большом скачке (>8с)
        if (!apiOk) {
            const bigJump = drift > 8;
            if (!isMobileVibe || playingChanged || bigJump || force) {
                syncVkViaEmbedReload(seconds, wantPlaying);
            }
        }
    }

    if (selectedPlatform === "rutube") {
        roomRutubeReady = true;
        // Production-style: только ctl, без iframe.src
        rutubeCtlApplyRemote(seconds, wantPlaying);
    }

    window.setTimeout(function () {
        roomApplyingRemoteState = false;
    }, selectedPlatform === "rutube" ? (isMobileVibe ? 800 : 400) : (isMobileVibe ? 1500 : 1200));
}

function reconcileRemotePlayback(payload) {
    // Хост — источник истины
    if (isRoomHost) return;
    if (!payload) return;

    const elapsed = payload.playing && payload.updatedAt
        ? Math.max(0, (Date.now() - Number(payload.updatedAt)) / 1000)
        : 0;
    const expected = (Number(payload.position) || 0) + elapsed;
    const drift = Math.abs(expected - roomPlaybackSeconds);
    // Clock на телефоне почти игнорируем — только грубый уход
    const clockThreshold = isMobileVibe ? (selectedPlatform === "rutube" ? 15 : 5) : 1.5;
    if (drift > clockThreshold) {
        applyRemotePlayback(payload, false);
    }
}

function sendYouTubeCommand(command, args) {
    if (!roomIframe || selectedPlatform !== "youtube" || !roomIframe.contentWindow) return;
    roomIframe.contentWindow.postMessage(JSON.stringify({
        event: "command",
        func: command,
        args: args || []
    }), "https://www.youtube.com");
}

function listenToYouTubePlayer() {
    if (!roomIframe || selectedPlatform !== "youtube" || !roomIframe.contentWindow) return;
    const target = roomIframe.contentWindow;
    target.postMessage(JSON.stringify({ event: "listening", id: 1, channel: "VIBE" }), "https://www.youtube.com");
    target.postMessage(JSON.stringify({ event: "command", func: "addEventListener", args: ["onStateChange"], channel: "VIBE" }), "https://www.youtube.com");
    target.postMessage(JSON.stringify({ event: "command", func: "addEventListener", args: ["onPlaybackRateChange"], channel: "VIBE" }), "https://www.youtube.com");
    target.postMessage(JSON.stringify({ event: "command", func: "getDuration", args: [], channel: "VIBE" }), "https://www.youtube.com");
}

window.addEventListener("message", function (event) {
    const fromOurFrame = roomIframe && event.source === roomIframe.contentWindow;
    const fromRutube = isRutubeMessageOrigin(event.origin);
    const fromYoutube = typeof event.origin === "string" && event.origin.indexOf("youtube.com") !== -1;
    if (!fromOurFrame && !fromRutube && !fromYoutube) return;

    let payload = event.data;
    if (typeof payload === "string") {
        try {
            payload = JSON.parse(payload);
        } catch (error) {
            return;
        }
    }
    if (!payload || typeof payload !== "object") return;

    if (selectedPlatform === "rutube" || fromRutube) {
        roomRutubeReady = true;
        handleRutubeMessage(payload);
        // pending seek/play после ready
        if (roomPendingSync && roomPlayerCtl.mediaReady) {
            const pendingSync = roomPendingSync;
            roomPendingSync = null;
            applyRemotePlayback(pendingSync, false);
        }
        return;
    }

    if (selectedPlatform !== "youtube" || !payload || payload.event !== "infoDelivery" || !payload.info) return;
    if (typeof payload.info.currentTime === "number") {
        roomPlaybackSeconds = payload.info.currentTime;
        renderPlaybackTime();
    }
    if (typeof payload.info.duration === "number" && playerProgress) {
        playerProgress.dataset.duration = String(payload.info.duration);
    }
    if (payload.info.playerState === 1) setPlaybackState(roomPlaybackSeconds, true, isRoomHost && !roomApplyingRemoteState);
    if (payload.info.playerState === 0 || payload.info.playerState === 2) setPlaybackState(roomPlaybackSeconds, false, isRoomHost && !roomApplyingRemoteState);
});


function ensureStartOverlay() {
    // отключено — только нативный плеер платформы
    const el = document.getElementById("vibeStartOverlay");
    if (el) el.remove();
}

function toggleRoomPlayback() {
    // Один в комнате или нет сокета → считаем хостом
    const usersCount = Number(peopleCount && peopleCount.textContent) || 1;
    if (!isRoomHost && (usersCount <= 1 || !roomSocket || !roomSocket.connected)) {
        isRoomHost = true;
    }
    // Гость тоже может нажать «Смотреть» — видео стартует локально (autoplay policy),
    // в общий канал уйдёт только если isRoomHost (см. setPlaybackState).

    setGuestPlayerInteractive(true);
    hideVibePlaceholder();

    const nextState = !roomPlaybackRunning;

    if (selectedPlatform === "youtube") {
        sendYouTubeCommand(nextState ? "playVideo" : "pauseVideo");
        if (nextState) sendYouTubeCommand("unMute");
    } else if (selectedPlatform === "vk") {
        let ok = false;
        if (roomVkPlayer) {
            try {
                if (nextState) {
                    if (typeof roomVkPlayer.play === "function") { roomVkPlayer.play(); ok = true; }
                    else if (typeof roomVkPlayer.playVideo === "function") { roomVkPlayer.playVideo(); ok = true; }
                } else {
                    if (typeof roomVkPlayer.pause === "function") { roomVkPlayer.pause(); ok = true; }
                    else if (typeof roomVkPlayer.pauseVideo === "function") { roomVkPlayer.pauseVideo(); ok = true; }
                }
            } catch (e) { ok = false; }
        }
        if (!ok) {
            syncVkViaEmbedReload(roomPlaybackSeconds, nextState);
        }
    } else if (selectedPlatform === "rutube") {
        if (nextState) {
            rutubeForcePlay(roomPlaybackSeconds);
        } else {
            rutubeForcePause();
            sendRutubeCommand("player:setCurrentTime", { time: roomPlaybackSeconds });
        }
    } else {
        // неизвестная платформа — пробуем клик по iframe бесполезен, просто UI
    }

    setPlaybackState(roomPlaybackSeconds, nextState, true);
}

function formatRoomDuration(seconds) {
    const totalSeconds = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor(totalSeconds % 3600 / 60);
    const remainder = totalSeconds % 60;
    if (hours > 0) {
        return String(hours).padStart(2, "0") + ":" + String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0");
    }
    return String(minutes).padStart(2, "0") + ":" + String(remainder).padStart(2, "0");
}

function renderParticipantTimers() {
    const now = Date.now();
    if (!peopleList) return;
    peopleList.querySelectorAll("[data-joined-at]").forEach(function (timer) {
        const joinedAt = Number(timer.dataset.joinedAt) || now;
        timer.textContent = formatRoomDuration((now - joinedAt) / 1000);
    });
}

function updateRoomPeople(payload) {
    const data = typeof payload === "number" ? { count: payload, participants: [] } : (payload || {});
    roomParticipants = Array.isArray(data.participants) ? data.participants : [];
    const count = Number(data.count) || roomParticipants.length || 1;
    if (peopleCount) peopleCount.textContent = String(Math.max(1, count));
    if (!peopleList) return;

    peopleList.replaceChildren();

    const participants = roomParticipants.length ? roomParticipants : [{ id: roomSocket && roomSocket.id, joinedAt: Date.now() }];
    participants.forEach(function (participant, index) {
        const person = document.createElement("div");
        person.className = "person remote-person";
        const isCurrentUser = roomSocket && participant.id === roomSocket.id;
        const label = isCurrentUser ? "Вы" : "Участник " + (index + 1);
        const avatarClass = isCurrentUser ? "" : " second";
        person.innerHTML = "<div class=\"person-avatar" + avatarClass + "\">" + (isCurrentUser ? "В" : "V") + "</div><div class=\"person-info\"><strong>" + label + "</strong><small><span>онлайн</span> <span class=\"watch-room-timer\" data-joined-at=\"" + Number(participant.joinedAt || Date.now()) + "\">00:00</span></small></div><span class=\"person-status\"></span>";
        peopleList.appendChild(person);
    });
    if (!roomParticipantsTimer) {
        roomParticipantsTimer = window.setInterval(renderParticipantTimers, 1000);
    }
    renderParticipantTimers();
}

function startRoomChannel() {
    ensureRoomSocket();
    if (roomSocket) {
        if (!roomSocketHandlersBound) {
            roomSocket.on("room:playback", function (payload) {
                if (payload && payload.source === roomSocket.id) return;
                // Мобильный Rutube: никогда force (force → reload → цикл)
                applyRemotePlayback(payload, false);
            });
            roomSocket.on("room:clock", reconcileRemotePlayback);
            roomSocket.on("room:host", function (payload) {
                if (!payload) return;
                isRoomHost = payload.hostId === roomSocket.id;
                setGuestPlayerInteractive(isRoomHost);
                if (isRoomHost) {
                    addSystemMessage("Вы стали хостом комнаты. Управление плеером за вами.");
                } else {
                    addSystemMessage("Плеером управляет хост комнаты.");
                }
            });
            roomSocket.on("room:users", function (payload) {
                if (payload && payload.hostId) {
                    isRoomHost = payload.hostId === roomSocket.id;
                }
                updateRoomPeople(payload);
            });
            roomSocket.on("room:chat", function (payload) {
                if (payload && payload.username && payload.text) addChatMessage(payload.username, payload.text, true);
            });
            roomSocket.on("room:error", function (payload) {
                if (payload && payload.error) {
                    console.warn("VIBE room:", payload.error);
                }
            });
            roomSocket.on("connect", function () {
                if (!currentRoom || (watchPage && watchPage.classList.contains("hidden"))) return;
                roomSocket.emit("room:join", { code: currentRoom }, function (response) {
                    if (!response || !response.ok || !response.room) return;
                    isRoomHost = Boolean(response.isHost);
                    if (response.room.platform) selectedPlatform = response.room.platform;
                    if (response.room.videoUrl) currentVideoUrl = response.room.videoUrl;
                    if (response.room.name) currentRoomName = response.room.name;
                    try {
                        localStorage.setItem("vibe_room_" + currentRoom, JSON.stringify({
                            code: currentRoom,
                            platform: selectedPlatform,
                            videoUrl: currentVideoUrl,
                            name: currentRoomName,
                            createdAt: Date.now()
                        }));
                    } catch (e) {}
                    if (watchTitle) watchTitle.textContent = currentRoomName || "Вечер кино";
                    if (watchPlatform) watchPlatform.textContent = getPlatformName(selectedPlatform);
                    if (currentVideoUrl) {
                        loadRoomVideo();
                    }
                    applyRemotePlayback({
                        position: response.room.position,
                        playing: response.room.playing,
                        updatedAt: response.room.updatedAt
                    }, !(isMobileVibe && selectedPlatform === "rutube"));
                });
            });
            roomSocketHandlersBound = true;
        }

        function handleJoinResponse(response) {
            if (!response || !response.ok) {
                showVideoError(response && response.error ? response.error : "Не удалось подключиться к комнате.");
                if (currentVideoUrl) loadRoomVideo();
                return;
            }
            const room = response.room || {};
            isRoomHost = Boolean(response.isHost) || (room.hostId && roomSocket && roomSocket.id === room.hostId);
            if (room.platform) selectedPlatform = room.platform;
            if (room.videoUrl) currentVideoUrl = room.videoUrl;
            if (room.name) currentRoomName = room.name;

            // Сохраняем на телефоне, чтобы повторный вход работал
            try {
                localStorage.setItem("vibe_room_" + currentRoom, JSON.stringify({
                    code: currentRoom,
                    platform: selectedPlatform,
                    videoUrl: currentVideoUrl,
                    name: currentRoomName,
                    createdAt: Date.now()
                }));
            } catch (e) {}

            if (watchTitle) watchTitle.textContent = currentRoomName || "Вечер кино";
            if (watchPlatform) watchPlatform.textContent = getPlatformName(selectedPlatform);
            updateRoomPeople({ count: room.users || 1, participants: response.participants || [] });
            setGuestPlayerInteractive(isRoomHost);

            if (!currentVideoUrl) {
                showVideoError("Сервер не прислал ссылку на видео. Попросите хоста поделиться полной ссылкой комнаты.");
                return;
            }

            // Не сбрасываем roomVideoLoaded — повторный load на телефоне = чёрный экран
            loadRoomVideo();
            roomPendingSync = {
                position: room.position,
                playing: room.playing,
                updatedAt: room.updatedAt
            };
            // applyRemote вызовется после load iframe — без force
        }

        roomSocket.emit("room:join", { code: currentRoom }, handleJoinResponse);
        return;
    }

    if (!currentRoom || !supabaseClient || typeof supabaseClient.channel !== "function") return;
    if (roomChannel) supabaseClient.removeChannel(roomChannel);

    roomChannel = supabaseClient.channel("vibe-room:" + currentRoom, {
        config: { presence: { key: roomClientId } }
    });

    roomChannel
        .on("broadcast", { event: "playback" }, function (message) {
            const payload = message.payload || {};
            applyRemotePlayback({ position: payload.seconds, playing: payload.playing });
        })
        .on("broadcast", { event: "chat" }, function (message) {
            const payload = message.payload || {};
            if (payload.username && payload.text) addChatMessage(payload.username, payload.text, true);
        })
        .on("broadcast", { event: "room-ready" }, function () {
            if (roomPlaybackRunning || roomPlaybackSeconds > 0) {
                setPlaybackState(roomPlaybackSeconds, roomPlaybackRunning, true);
            }
        })
        .on("presence", { event: "sync" }, function () {
            const state = roomChannel.presenceState();
            updateRoomPeople(Object.keys(state).length);
            
            // 2. Мобильный фикс для второй ветки (Supabase)
            // Когда гость синхронизировался по базе данных, принудительно пушим ему видео
            if (typeof currentVideoUrl !== "undefined" && currentVideoUrl) {
                убратьЗаглушкуИВключитьПлеер(currentVideoUrl);
            }
        })
        .subscribe(async function (status) {
            if (status !== "SUBSCRIBED") return;
            await roomChannel.track({ id: roomClientId });
            roomChannel.send({ type: "broadcast", event: "room-ready", payload: {} });
        });
}

// ВСПОМОГАТЕЛЬНАЯ ФУНКЦИЯ ДЛЯ УНИЧТОЖЕНИЯ ЗАГЛУШКИ VIBE НА СМАРТФОНАХ
function убратьЗаглушкуИВключитьПлеер(url) {
    hideVibePlaceholder();
    const iframe = getPlayerIframe();
    if (iframe && iframe.src) {
        iframe.classList.remove("hidden");
        iframe.style.setProperty("display", "block", "important");
        iframe.style.setProperty("z-index", "5", "important");
    }
}

function showVideoMessage(text) {
    const iframe = getPlayerIframe && getPlayerIframe();
    // Если iframe уже с видео — не перекрываем заглушкой
    if (iframe && iframe.src && iframe.src.indexOf("http") === 0) {
        console.log("VIBE:", text);
        hideVibePlaceholder();
        return;
    }
    const placeholder = document.querySelector(".video-placeholder");
    if (!placeholder) return;

    placeholder.innerHTML = "";
    const logo = document.createElement("div");
    logo.className = "video-v";
    logo.textContent = "V";

    const title = document.createElement("div");
    title.className = "video-placeholder-title";
    title.textContent = "VIBE";

    const message = document.createElement("div");
    message.className = "video-placeholder-text";
    message.textContent = text;

    placeholder.appendChild(logo);
    placeholder.appendChild(title);
    placeholder.appendChild(message);
    // Показать только пока нет iframe
    placeholder.style.setProperty("display", "flex", "important");
    placeholder.style.setProperty("z-index", "1", "important");
    placeholder.style.setProperty("pointer-events", "none", "important");
}

function showVideoError(text) {
    showVideoMessage(text);
}


function askJoinRoom() {
    const code = prompt("Введите код комнаты VIBE:");
    if (!code) return;

    const cleanCode = code.trim().toUpperCase();
    const savedRoom = localStorage.getItem("vibe_room_" + cleanCode);

    currentRoom = cleanCode;
    currentVideoUrl = "";
    selectedPlatform = "";
    currentRoomName = "Вечер кино";

    if (savedRoom) {
        try {
            const room = JSON.parse(savedRoom);
            selectedPlatform = room.platform || "";
            currentVideoUrl = normalizeVideoSource(room.platform, room.videoUrl);
            currentRoomName = room.name || "Вечер кино";
        } catch (error) {
            console.warn("VIBE room parse:", error);
        }
    }

    // Даже без localStorage — заходим, URL придёт с сервера через room:join
    openWatchRoom();
}


if (backHome) {
    backHome.addEventListener("click", function () {
        leaveRoomSocket();
        if (watchPage) watchPage.classList.add("hidden");
        if (roomsPage) roomsPage.classList.add("hidden");

        const homePage = document.getElementById("homePage");
        if (homePage) homePage.classList.remove("hidden");

        document.body.style.overflow = "";
        document.title = "VIBE — Смотри вместе";
        window.scrollTo({ top: 0, behavior: "smooth" });
    });
}


if (inviteButton) {
    inviteButton.addEventListener("click", async function () {
        const link = getRoomLink();
        const text = "Присоединяйся к моей комнате VIBE!\n\n" + link;
        const label = inviteButton.querySelector("span");
        const defaultLabel = "Поделиться комнатой";

        try {
            await navigator.clipboard.writeText(text);
            if (label) label.textContent = "Ссылка скопирована ✓";
            setTimeout(function () {
                if (label) label.textContent = defaultLabel;
            }, 1800);
        } catch (error) {
            prompt("Скопируйте ссылку:", link);
        }
    });
}


if (chatForm) {
    chatForm.addEventListener("submit", function (event) {
        event.preventDefault();
        if (!chatInput) return;

        const text = chatInput.value.trim();
        if (!text) return;

        addChatMessage("Вы", text);
        chatInput.value = "";
    });
}

document.querySelectorAll(".watch-tab").forEach(function (tab) {
    tab.addEventListener("click", function () {
        document.querySelectorAll(".watch-tab").forEach(function (item) {
            item.classList.toggle("active", item === tab);
        });
    });
});

function addChatMessage(username, text) {
    if (!chatMessages) return;

    const message = document.createElement("div");
    message.className = "chat-message";

    const avatar = document.createElement("div");
    avatar.className = "chat-avatar";
    avatar.textContent = username === "Вы" ? "В" : username.charAt(0).toUpperCase();

    const content = document.createElement("div");
    const name = document.createElement("strong");
    name.textContent = username;
    const paragraph = document.createElement("p");
    paragraph.textContent = text;

    content.appendChild(name);
    content.appendChild(paragraph);
    message.appendChild(avatar);
    message.appendChild(content);
    chatMessages.appendChild(message);
    chatMessages.scrollTop = chatMessages.scrollHeight;

    if (arguments[2] !== true) {
        if (roomSocket && roomSocket.connected) {
            roomSocket.emit("room:chat", { username: username, text: text });
        } else if (roomChannel) {
            roomChannel.send({
                type: "broadcast",
                event: "chat",
                payload: { username: username, text: text }
            });
        }
    }
}

function addSystemMessage(text) {
    addChatMessage("VIBE", text);
}


// toggleRoomPlayback defined above (YouTube + VK + Rutube)

function bindPlayControl(el) {
    if (!el || el.dataset.vibeBound) return;
    el.dataset.vibeBound = "1";
    el.style.pointerEvents = "auto";
    el.style.touchAction = "manipulation";
    el.style.zIndex = "35";
    const go = function (e) {
        if (e) {
            e.preventDefault();
            e.stopPropagation();
        }
        toggleRoomPlayback();
    };
    el.addEventListener("click", go, { passive: false });
    el.addEventListener("touchend", go, { passive: false });
}
bindPlayControl(playButton);
bindPlayControl(playerPlay);

if (playerProgress) {
    playerProgress.addEventListener("change", function () {
        if (!isRoomHost && roomSocket && roomSocket.connected) return;
        const duration = Number(playerProgress.dataset.duration) || 0;
        // Если длительность неизвестна — считаем 2 часа (для VK/Rutube пока нет duration)
        const effectiveDuration = duration > 0 ? duration : 7200;
        const position = Number(playerProgress.value) / 100 * effectiveDuration;
        roomPlaybackSeconds = position;

        if (selectedPlatform === "youtube") {
            sendYouTubeCommand("seekTo", [position, true]);
        } else if (selectedPlatform === "vk") {
            if (roomVkPlayer && typeof roomVkPlayer.seek === "function") {
                try { roomVkPlayer.seek(position); } catch (e) {}
            } else {
                syncVkViaEmbedReload(position, roomPlaybackRunning);
            }
        } else if (selectedPlatform === "rutube") {
            sendRutubeCommand("player:setCurrentTime", { time: position });
            sendRutubeCommand("player:seek", { time: position });
        }

        setPlaybackState(position, roomPlaybackRunning, true);
    });
}

if (playerMute) {
    playerMute.addEventListener("click", function () {
        if (selectedPlatform === "youtube") {
            const muted = playerMute.dataset.muted === "true";
            sendYouTubeCommand(muted ? "unMute" : "mute");
            playerMute.dataset.muted = String(!muted);
            playerMute.textContent = muted ? "🔊" : "🔇";
        }
    });
}

if (playerFullscreen) {
    playerFullscreen.addEventListener("click", function () {
        const frame = document.querySelector("#watchPage .video-player");
        if (!frame) return;
        if (document.fullscreenElement) {
            document.exitFullscreen?.();
        } else {
            frame.requestFullscreen?.();
        }
    });
}


if (roomsBack) {
    roomsBack.addEventListener("click", closeRoomsPage);
}

if (roomLinkButton) {
    roomLinkButton.addEventListener("click", function () {
        if (!roomLinkInput) return;

        const value = roomLinkInput.value.trim();
        if (roomLinkError) roomLinkError.classList.add("hidden");

        if (!value) {
            if (roomLinkError) {
                roomLinkError.textContent = "Вставьте ссылку на комнату.";
                roomLinkError.classList.remove("hidden");
            }
            return;
        }

        let roomCode = "";
        try {
            const url = new URL(value);
            roomCode = url.searchParams.get("room") || url.searchParams.get("code") || "";
        } catch (error) {
            roomCode = value;
        }

        roomCode = roomCode.trim().toUpperCase();

        if (!roomCode && /^VIBE-[A-Z0-9]+$/i.test(value)) {
            roomCode = value.trim().toUpperCase();
        }

        if (!roomCode) {
            if (roomLinkError) {
                roomLinkError.textContent = "Неверная ссылка на комнату.";
                roomLinkError.classList.remove("hidden");
            }
            return;
        }

        const roomKey = "vibe_room_" + roomCode;
        const roomData = localStorage.getItem(roomKey);

        if (!roomData && value.includes("?")) {
            try {
                const shared = new URL(value);
                const sharedPlatform = shared.searchParams.get("platform");
                const sharedVideo = shared.searchParams.get("video");
                if (sharedPlatform && sharedVideo) {
                    currentRoom = roomCode;
                    selectedPlatform = sharedPlatform;
                    currentVideoUrl = normalizeVideoSource(sharedPlatform, sharedVideo);
                    currentRoomName = shared.searchParams.get("name") || "Вечер кино";
                    openWatchRoom();
                    return;
                }
            } catch (error) {
                console.error("VIBE shared room link error:", error);
            }
        }

        if (!roomData) {
            currentRoom = roomCode;
            openWatchRoom();
            return;
        }

        try {
            const room = JSON.parse(roomData);
            currentRoom = room.code;
            currentVideoUrl = normalizeVideoSource(room.platform, room.videoUrl);
            currentRoomName = room.name || "Вечер кино";
            selectedPlatform = room.platform;
            openWatchRoom();
        } catch (error) {
            console.error("VIBE link error:", error);
            if (roomLinkError) {
                roomLinkError.textContent = "Не удалось открыть комнату.";
                roomLinkError.classList.remove("hidden");
            }
        }
    });
}


mobileNavItems.forEach(function (item) {
    item.addEventListener("click", function () {
        mobileNavItems.forEach(function (nav) {
            nav.classList.remove("active");
        });
        item.classList.add("active");

        const nav = item.dataset.nav;

        if (nav === "home") {
            closeMovieDetails();
            closeCatalogPage();
            closeRoomsPage();
            return;
        }

        if (nav === "catalog") {
            openCatalogPage();
            return;
        }

        if (nav === "rooms") {
            openRoomsPage();
            return;
        }

        if (nav === "news") {
            openNewsModal();
            return;
        }

        if (nav === "login") {
            if (authModal) authModal.classList.remove("hidden");
        }
    });
});


function openRoomFromUrl() {
    const params = new URLSearchParams(window.location.search);
    const roomCode = params.get("room");
    if (!roomCode) return;

    const cleanCode = roomCode.trim().toUpperCase();
    currentRoom = cleanCode;
    currentRoomName = params.get("name") || "Вечер кино";

    const videoParam = params.get("video");
    const platformParam = params.get("platform");
    if (videoParam) {
        selectedPlatform = platformParam || detectPlatformFromUrl(videoParam) || "";
        currentVideoUrl = normalizeVideoSource(selectedPlatform || detectPlatformFromUrl(videoParam), videoParam);
        if (!selectedPlatform) selectedPlatform = detectPlatformFromUrl(currentVideoUrl || videoParam);
    } else {
        currentVideoUrl = "";
        selectedPlatform = "";
        const roomData = localStorage.getItem("vibe_room_" + cleanCode);
        if (roomData) {
            try {
                const room = JSON.parse(roomData);
                selectedPlatform = room.platform || "";
                currentVideoUrl = normalizeVideoSource(room.platform, room.videoUrl);
                currentRoomName = room.name || currentRoomName;
            } catch (error) {
                console.error("VIBE URL room error:", error);
            }
        }
    }

    openWatchRoom();
}


document.addEventListener("keydown", function (event) {
    if (event.key !== "Escape") return;

    if (moviePlayerModal && !moviePlayerModal.classList.contains("hidden")) {
        closeMoviePlayer();
    } else if (watchPage && !watchPage.classList.contains("hidden")) {
        if (backHome) backHome.click();
    } else if (roomModal && roomModal.classList.contains("show")) {
        closeRoomModal();
    } else if (roomsPage && !roomsPage.classList.contains("hidden")) {
        closeRoomsPage();
    } else if (catalogPage && !catalogPage.classList.contains("hidden")) {
        closeCatalogPage();
    } else if (newsModal && !newsModal.classList.contains("hidden")) {
        closeNewsModal();
    }
});






try {
    openRoomFromUrl();
} catch (e) {
    console.warn("VIBE openRoomFromUrl:", e);
}
console.log("VIBE успешно запущен.");

window.addEventListener("error", function (ev) {
    console.warn("VIBE page error:", ev && ev.message ? ev.message : ev);
});


