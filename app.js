import { createClient } from "@supabase/supabase-js";
import { SUPABASE_URL, SUPABASE_ANON_KEY } from "./supabase-config.js";

// 1. Supabase client
//
// The anon key is intentionally public: Row Level Security in Postgres is what
// guards the data, and it requires a signed-in session for every read and write.
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const SAVE_TIMEOUT_MS = 15000;
const UPLOAD_TIMEOUT_MS = 30000;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_INPUT_BYTES = 25 * 1024 * 1024;
const MAX_IMAGE_DIMENSION = 1000;
const JPEG_QUALITY = 0.82;
const IMAGE_BUCKET = "product-images";
const allowedImageTypes = ["image/jpeg", "image/png", "image/webp", "image/gif"];

// Featured slides: same bucket, one new folder inside it
const SLIDES_TABLE = "featured_slides";
const FEATURED_BANNER_FOLDER = "banner";
const DEFAULT_BUTTON_LABEL = "Order Now";
// Matches the app's own "only N left" threshold, so the dashboard and
// the storefront agree on what counts as running low.
const LOW_STOCK = 5;

// The store skincare taxonomy: the same six categories appear as the
// storefront filter chips and as the products_category_check constraint
// in supabase/schema.sql. Keep all three lists in step.
const CATEGORIES = [
    "Cleansers",
    "Moisturizers",
    "Sunscreens",
    "Serums & Treatments",
    "Toners",
    "Masks & Exfoliators"
];
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

let productsChannel = null;
let activeUserId = null;
let editingProductId = null;
let editingImageUrl = null;
// The stock value the edit modal was opened with. The save only sends
// `stock` when the admin actually changed this box, so editing the name
// or price during a live sale cannot resurrect units a customer already
// bought (see saveProduct).
let editingStockAtOpen = null;
let editModalInstance = null;

let slidesChannel = null;
let editingSlideId = null;
let editingSlideBannerUrl = null;
let slideModalInstance = null;
let productSelectSignature = "";

// The order log. Read only -- see section 8c.
let ordersChannel = null;
let orderModalInstance = null;

// 'all' | 'Completed' | 'Cancelled'
let activeOrderStatus = "all";

// productId -> { element, signature }
const productRows = new Map();

// orderId -> { element, signature, order }
const orderRows = new Map();

// productId -> product, so the slide form can offer a picker without a second query
const productCatalog = new Map();

// slideId -> { element, signature, slide }
const slideRows = new Map();

// Slide ids with a write already in flight, so a double click cannot double-write
const slideWrites = new Set();


// 2. Shared helpers

// Rejects a stalled write instead of hanging forever with no feedback
function withTimeout(promise, ms, message) {
    let timer;

    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Supabase errors arrive as plain objects with a message and optional code,
// rather than the opaque string codes Firebase used.
const errorMessages = {
    "42501": "This account is not allowed to save. Catalog and banner changes are restricted to admin accounts -- run: update public.profiles set role = 'admin' where username = 'your-username'",
    "PGRST204": "The database is missing a column this dashboard writes (featured_slides.description). Re-run supabase/schema.sql and then: notify pgrst, 'reload schema';",
    PGRST116: "That product no longer exists.",
    ECONNREFUSED: "Could not reach Supabase. Check your project URL in supabase-config.js.",
    "Invalid login credentials": "Invalid email or password."
};

function describeError(error, fallback) {
    if (!error) {
        return fallback;
    }

    const code = String(error.code || "");
    const message = String(error.message || "");

    // 42501 gets the promotion command tailored to this session's user.
    // Targeting by id cannot miss: usernames can be renamed, and sign-up
    // appends _1, _2 when the base name is taken, so a
    // `where username = ...` update can silently match zero rows.
    if (code === "42501" && activeUserId) {
        return (
            "This account is not allowed to save. Catalog and banner changes " +
            "are restricted to admin accounts -- run: update public.profiles " +
            `set role = 'admin' where id = '${activeUserId}';`
        );
    }

    if (errorMessages[code]) {
        return errorMessages[code];
    }

    const matched = Object.keys(errorMessages).find((key) => code.includes(key) || message.includes(key));

    if (matched) {
        return errorMessages[matched];
    }

    return message || fallback;
}

function validateImageUrl(value) {
    const url = value.trim();

    if (url === "") {
        return null; // an image is optional
    }

    let parsed;

    try {
        parsed = new URL(url);
    } catch (error) {
        return "Enter a full image URL, starting with https://";
    }

    // Only http(s) is accepted, so javascript:, data:, and file: can never
    // reach the src attribute
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return "Image URL must start with http:// or https://";
    }

    if (!parsed.hostname) {
        return "Enter a full image URL, starting with https://";
    }

    return null;
}

// Price is required and a blank box is a mistake, not a request for
// "free". Number("") is 0 in JS, so without this guard an emptied price
// field would silently submit as 0.00 and the "please enter a price"
// validation below could never fire. (Stock is different: a blank stock
// box deliberately means zero -- see parseStock.)
function parsePrice(value) {
    const text = String(value ?? "").trim();

    if (text === "") {
        return null;
    }

    const price = Number(text);

    if (!Number.isFinite(price) || price < 0) {
        return null;
    }

    return price;
}

function formatPrice(value) {
    const price = Number(value);

    if (!Number.isFinite(price)) {
        return "PHP 0";
    }

    return `PHP ${price.toLocaleString("en-PH", { maximumFractionDigits: 2 })}`;
}

// Stock is a whole count of things, so a fractional number is a typo
// rather than something to round. An empty box means "none declared",
// which is zero.
function parseStock(value) {
    const trimmed = String(value ?? "").trim();

    if (trimmed === "") {
        return 0;
    }

    const stock = Number(trimmed);

    if (!Number.isInteger(stock) || stock < 0) {
        return null;
    }

    return stock;
}

function formatStock(value) {
    const stock = Number(value);

    if (!Number.isFinite(stock)) {
        return "--";
    }

    return stock <= 0 ? "Sold out" : `${stock.toLocaleString("en-PH")} in stock`;
}

function setBusy(buttonId, busyLabel, idleLabel, isBusy) {
    const button = document.getElementById(buttonId);
    button.disabled = isBusy;
    button.textContent = isBusy ? busyLabel : idleLabel;
}


// ---------------------------------------------------------------------------
// 2b. Image upload
//
// Files go to the public "product-images" bucket. Only the resulting URL is
// written to Postgres, so the database never carries image bytes and the
// mobile app reads images straight from Storage's CDN.
// ---------------------------------------------------------------------------

function validateImageFile(file) {
    if (!allowedImageTypes.includes(file.type)) {
        return "Only JPG, PNG, WebP, or GIF images are allowed.";
    }

    if (file.size > MAX_INPUT_BYTES) {
        return "Image must be 25 MB or smaller.";
    }

    return null;
}

function formatBytes(bytes) {
    if (!bytes) {
        return "0 KB";
    }

    if (bytes < 1024 * 1024) {
        return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    }

    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// crypto.randomUUID needs a secure context, which plain-HTTP LAN hosting is not
function uniqueId() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }

    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function canvasToBlob(canvas, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => {
            if (blob) {
                resolve(blob);
            } else {
                reject(new Error("Image could not be processed."));
            }
        }, "image/jpeg", quality);
    });
}

// Decodes off the main thread where the browser supports it
function decodeImage(file) {
    if (typeof createImageBitmap === "function") {
        return createImageBitmap(file);
    }

    return new Promise((resolve, reject) => {
        const objectUrl = URL.createObjectURL(file);
        const image = new Image();

        image.onload = () => {
            URL.revokeObjectURL(objectUrl);
            resolve(image);
        };

        image.onerror = () => {
            URL.revokeObjectURL(objectUrl);
            reject(new Error("That file could not be read as an image."));
        };

        image.src = objectUrl;
    });
}

// Caps the long edge at MAX_IMAGE_DIMENSION and steps quality down until the
// encoded file fits the bucket limit. A 2 MB phone photo typically lands around
// 100-200 KB, which is what makes the upload feel fast on a slow connection.
async function compressImage(file) {
    const source = await decodeImage(file);
    const longestEdge = Math.max(source.width, source.height);
    const scale = Math.min(1, MAX_IMAGE_DIMENSION / longestEdge);

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(source.width * scale));
    canvas.height = Math.max(1, Math.round(source.height * scale));

    const context = canvas.getContext("2d");

    // JPEG has no alpha channel, so paint a white backdrop first --
    // otherwise transparent PNGs flatten to black
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.imageSmoothingQuality = "high";
    context.drawImage(source, 0, 0, canvas.width, canvas.height);

    if (typeof source.close === "function") {
        source.close();
    }

    let quality = JPEG_QUALITY;
    let blob = await canvasToBlob(canvas, quality);

    while (blob.size > MAX_IMAGE_BYTES && quality > 0.4) {
        quality -= 0.15;
        blob = await canvasToBlob(canvas, quality);
    }

    if (blob.size > MAX_IMAGE_BYTES) {
        throw new Error("Image could not be reduced below 2 MB. Please choose a smaller image.");
    }

    return blob;
}

// The Supabase storage client exposes no upload progress events, so the UI
// reports real stages (optimizing / uploading N KB) rather than a fake percent
async function uploadImage(file, onProgress) {
    const error = validateImageFile(file);

    if (error) {
        throw new Error(error);
    }

    onProgress("Optimizing image...");
    const blob = await compressImage(file);

    onProgress(`Uploading ${formatBytes(blob.size)}...`);

    // Unique names mean cached thumbnails never go stale after a replacement
    const path = `${Date.now()}-${uniqueId()}.jpg`;
    const bucket = supabase.storage.from(IMAGE_BUCKET);

    const { error: uploadError } = await withTimeout(
        bucket.upload(path, blob, {
            contentType: "image/jpeg",
            cacheControl: "31536000",
            upsert: false
        }),
        UPLOAD_TIMEOUT_MS,
        "The upload timed out. Check your connection and try again."
    );

    if (uploadError) {
        throw uploadError;
    }

    onProgress("Finishing up...");

    return bucket.getPublicUrl(path).data.publicUrl;
}

// ---------------------------------------------------------------------------
// 2c. Featured slide uploads
//
// Slide images live in two folders inside the same product-images bucket:
//   featured/banner/<file>  ->  banner_url
// No new bucket, no new storage policy.
//
// Unlike product images these are uploaded byte-for-byte. The product uploader
// re-encodes to JPEG because the admin previews it inline; a banner is drawn
// by the phone straight off the CDN, so the original file goes up untouched and
// the content type has to be derived from the extension. Labelling a PNG
// image/jpeg is what makes uploads silently fail to render in the app.
// ---------------------------------------------------------------------------

const MIME_TYPES_BY_EXTENSION = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    webp: "image/webp",
    gif: "image/gif",
    avif: "image/avif"
};

// Filesystem names are less trustworthy than the MIME type the browser reports,
// but a name is what the CDN serves back, so it is what decides the extension.
function extensionFor(file) {
    const fromName = String(file.name || "").split(".").pop().toLowerCase();

    if (MIME_TYPES_BY_EXTENSION[fromName]) {
        return fromName === "jpeg" ? "jpg" : fromName;
    }

    const subtype = String(file.type || "").split("/")[1] || "";
    const normalized = subtype.toLowerCase() === "jpeg" ? "jpg" : subtype.toLowerCase();

    return MIME_TYPES_BY_EXTENSION[normalized] ? normalized : "bin";
}

function mimeTypeFor(file) {
    const extension = extensionFor(file);
    return MIME_TYPES_BY_EXTENSION[extension] || file.type || "application/octet-stream";
}

async function uploadFeaturedImage(file, folder, label, onProgress) {
    const error = validateImageFile(file);

    if (error) {
        throw new Error(error);
    }

    onProgress(`Uploading ${label} (${formatBytes(file.size)})...`);

    // Timestamp plus a random suffix keeps every name unique, so a cached
    // banner can never outlive the slide it belonged to.
    const path = `featured/${folder}/${Date.now()}-${uniqueId()}.${extensionFor(file)}`;
    const bucket = supabase.storage.from(IMAGE_BUCKET);

    const { error: uploadError } = await withTimeout(
        bucket.upload(path, file, {
            contentType: mimeTypeFor(file),
            cacheControl: "31536000",
            upsert: false
        }),
        UPLOAD_TIMEOUT_MS,
        "The upload timed out. Check your connection and try again."
    );

    if (uploadError) {
        throw uploadError;
    }

    return bucket.getPublicUrl(path).data.publicUrl;
}

// Resolves the image to persist: a fresh upload, a pasted URL, or nothing
function resolveImageInput(fileInput, urlInput, onProgress) {
    const file = fileInput.files[0];

    if (file) {
        return uploadImage(file, onProgress);
    }

    const url = urlInput.value.trim();

    if (url !== "") {
        return Promise.resolve(url);
    }

    return Promise.resolve(null);
}

// Extracts the object path from a public Storage URL, so we only ever delete
// files this dashboard uploaded. Returns null for anything else -- including an
// external URL that merely contains a matching path, which would otherwise make
// us delete an unrelated file from our own bucket.
const SUPABASE_ORIGIN = SUPABASE_URL.replace(/\/+$/, "");

function imagePathFromUrl(url) {
    if (!url || !url.startsWith(`${SUPABASE_ORIGIN}/`)) {
        return null;
    }

    const marker = `/storage/v1/object/public/${IMAGE_BUCKET}/`;
    const index = url.indexOf(marker);

    if (index === -1) {
        return null;
    }

    return decodeURIComponent(url.slice(index + marker.length));
}

// Best-effort cleanup: an orphaned file should never fail the user's action
function deleteStoredImage(url) {
    const path = imagePathFromUrl(url);

    if (!path) {
        return Promise.resolve();
    }

    return supabase.storage.from(IMAGE_BUCKET).remove([path]).then(({ error }) => {
        if (error) {
            console.warn("Could not remove the previous image:", error.message);
        }
    });
}

// Upload activity, without pretending to know a percentage we cannot measure
function showProgress(prefix, text) {
    document.getElementById(`${prefix}Progress`).classList.remove("d-none");
    document.getElementById(`${prefix}ProgressText`).textContent = text;
}

function hideProgress(prefix) {
    document.getElementById(`${prefix}Progress`).classList.add("d-none");
    document.getElementById(`${prefix}ProgressText`).textContent = "";
}


function showImagePreview(prefix, source) {
    const preview = document.getElementById(`${prefix}ImagePreview`);
    const img = document.getElementById(`${prefix}ImagePreviewImg`);

    if (!source) {
        preview.classList.add("d-none");
        img.removeAttribute("src");
        return;
    }

    img.src = source;
    preview.classList.remove("d-none");
}

function clearImageSelection() {
    document.getElementById("imageFile").value = "";
    document.getElementById("imageUrl").value = "";
    showImagePreview("add", null);
}


// 3. Auth//
// Supabase owns credentials: passwords are bcrypt-hashed and never stored in a
// table this app can read. Sessions survive a reload via localStorage.
// The dashboard is admin-only, but Supabase Auth cannot know that:
// the same credentials also sign into the storefront app, where
// customers must be able to log in. So the gate lives here. Every
// auth entry point must resolve to role = 'admin' before the
// dashboard is built; anyone else is signed straight back out and
// told why on the login screen.
//
// Set before signing a denied account out; showLoginView() reads it.
// (onAuthStateChange delivers SIGNED_OUT inside signOut(), so the
// message has to already be in place -- assigning it afterwards would
// race the login view's own clear.)
let loginNotice = "";

// 'admin' | 'blocked' | 'unknown'. 'unknown' means the profile read
// itself failed (network, schema drift) -- which is not proof of
// anything and must not sign anyone out.
async function verifyAdminAccess(userId) {
    try {
        const { data, error } = await supabase
            .from("profiles")
            .select("role")
            .eq("id", userId)
            .maybeSingle();

        if (error) {
            console.error("Could not resolve the admin role:", error);
            return "unknown";
        }

        return data && data.role === "admin" ? "admin" : "blocked";
    } catch (error) {
        console.error("Could not resolve the admin role:", error);
        return "unknown";
    }
}

async function denyDashboardAccess() {
    loginNotice =
        "This dashboard is for admin accounts only. This account can keep " +
        "using the mobile app; catalog access requires role 'admin'.";

    await supabase.auth.signOut();
}

async function enterDashboard(user) {
    const verdict = await verifyAdminAccess(user.id);

    if (verdict === "blocked") {
        await denyDashboardAccess();
        return;
    }

    // 'unknown' must not sign an admin out over a flaky connection.
    // The dashboard opens and the database still refuses every write
    // that is not from an admin, so failing open here only exposes
    // reads the storefront already has.
    showDashboardView(user);
}

function showLoginView() {
    activeUserId = null;

    document.getElementById("dashboardSection").classList.add("d-none");
    document.getElementById("loginSection").classList.remove("d-none");
    document.getElementById("userProfileArea").classList.add("d-none");
    document.getElementById("userProfileArea").classList.remove("d-flex");
    document.getElementById("password").value = "";
    document.getElementById("loginMessage").textContent = loginNotice;

    unsubscribeFromProducts();
    clearProductRows();

    // Both realtime sockets are torn down together, or a slide change keeps
    // arriving after the session that authorised it is gone. The order
    // log is no different, and matters more to clear: those rows carry
    // customer names and addresses.
    unsubscribeFromSlides();
    clearSlideRows();
    unsubscribeFromOrders();
    clearOrderRows();
    switchPanel("products");
}

function showDashboardView(user) {
    // onAuthStateChange fires INITIAL_SESSION on registration and getSession()
    // resolves the same session, so guard against building the view twice
    if (activeUserId === user.id) {
        return;
    }

    activeUserId = user.id;

    document.getElementById("loginSection").classList.add("d-none");
    document.getElementById("dashboardSection").classList.remove("d-none");
    document.getElementById("userProfileArea").classList.remove("d-none");
    document.getElementById("userProfileArea").classList.add("d-flex");
    document.getElementById("currentUser").textContent = user.email || "";

    loadProducts();
    loadSlides();

    // The orders read is admin-only, which the gate above has already
    // established, so this succeeds. It still fails softly: a transient
    // error here should not take down the rest of the dashboard.
    loadOrders();
}

async function handleLogin(event) {
    event.preventDefault();

    const email = document.getElementById("email").value.trim();
    const password = document.getElementById("password").value;
    const loginMessage = document.getElementById("loginMessage");

    // A fresh attempt clears any previous denial notice, or
    // showLoginView() would resurrect it after a failed password.
    loginNotice = "";
    loginMessage.textContent = "";
    setBusy("loginButton", "Logging in...", "Sign In to Dashboard", true);

    const { error } = await supabase.auth.signInWithPassword({ email, password });

    setBusy("loginButton", "Logging in...", "Sign In to Dashboard", false);

    // onAuthStateChange handles showing the dashboard, so only report failures
    if (error) {
        loginMessage.textContent = describeError(error, "Invalid email or password.");
        return;
    }

    document.getElementById("password").value = "";
}

async function handleLogout() {
    // Tear down the realtime socket first, or it keeps receiving rows
    // for a session that is about to be gone
    unsubscribeFromProducts();
    clearProductRows();
    unsubscribeFromSlides();
    clearSlideRows();
    unsubscribeFromOrders();
    clearOrderRows();

    // A voluntary logout must not re-show a stale "admin only" denial
    loginNotice = "";

    await supabase.auth.signOut();
}

function initAuth() {
    // Single source of truth for which view is visible. Every session
    // goes through enterDashboard(): it verifies role = 'admin' and
    // signs anyone else straight back out.
    supabase.auth.onAuthStateChange((event, session) => {
        if (event === "SIGNED_OUT") {
            showLoginView();
            return;
        }

        if (session) {
            // Deliberately not awaited: supabase-js advises against
            // blocking the auth callback, and enterDashboard() does its
            // own view changes when the check resolves.
            enterDashboard(session.user);
        }
    });

    // onAuthStateChange only fires on changes, so check for an existing
    // session on load — otherwise a refresh would bounce to the login screen
    supabase.auth.getSession().then(({ data }) => {
        if (data.session) {
            enterDashboard(data.session.user);
        } else {
            showLoginView();
        }
    });

    // Live search filtering on inventory table. The work lives in
    // applyProductSearch() so the same filter can be re-applied after a
    // reload or when a row arrives over realtime -- otherwise a product
    // added while a search is active ignores the search and shows up
    // regardless.
    const searchInput = document.getElementById("inventorySearch");
    if (searchInput) {
        searchInput.addEventListener("input", applyProductSearch);
    }
}

// Re-applies the inventory search box to every rendered product row.
function applyProductSearch() {
    const searchInput = document.getElementById("inventorySearch");
    const query = (searchInput ? searchInput.value : "").toLowerCase().trim();

    productRows.forEach((row) => {
        const text = row.element.textContent.toLowerCase();
        row.element.style.display = text.includes(query) ? "" : "none";
    });
}


// 4. Read Data (Real-time Sync)
function loadProducts() {
    // Clear both the DOM and the row map up front, before the query is
    // even sent. Clearing only the DOM (the old behaviour) left a stale
    // map behind: a realtime event arriving while the query was still in
    // flight would re-add a <tr> to the emptied table, then the response
    // cleared the map without removing that element, so the product was
    // rendered twice -- once as an orphan the app no longer tracked.
    clearProductRows();

    // Ordered so the inventory reads oldest-first, matching the old push order
    supabase
        .from("products")
        .select("*")
        .order("created_at", { ascending: true })
        .then(({ data, error }) => {
            if (error) {
                console.error("Unable to load products:", error);
                return;
            }

            data.forEach(upsertProductRow);
            applyProductSearch();

            // The catalog is now in, so any slide row that rendered
            // before its product arrived can show its real label.
            refreshSlideProductLabels();
        });

    subscribeToProducts();
}

// Realtime pushes only the rows that changed, so thumbnails in untouched rows
// are never torn down and re-decoded
function subscribeToProducts() {
    if (productsChannel) {
        return;
    }

    productsChannel = supabase
        .channel("products")
        .on("postgres_changes", { event: "*", schema: "public", table: "products" }, (payload) => {
            if (payload.eventType === "DELETE") {
                removeProductRow(payload.old.id);
                return;
            }

            upsertProductRow(payload.new);
        })
        .subscribe((status) => {
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                console.warn(`Realtime channel status: ${status}`);
            }
        });
}

function unsubscribeFromProducts() {
    if (!productsChannel) {
        return;
    }

    supabase.removeChannel(productsChannel);
    productsChannel = null;
}

function clearProductRows() {
    productRows.forEach((row) => row.element.remove());
    productRows.clear();

    // Drop the cached catalog too. This map fed the slide product
    // picker, and it was never cleared, so a product deleted while the
    // dashboard was closed survived logout/login and kept appearing in
    // the picker -- linking a slide to it then failed the foreign key
    // with a confusing error.
    productCatalog.clear();

    document.getElementById("tableBody").innerHTML = "";
}

function upsertProductRow(product) {
    if (!product || !product.id) {
        return;
    }

    // The slide form picks from the same catalog the table renders, so there is
    // no second products query to keep in sync
    productCatalog.set(product.id, product);

    let row = productRows.get(product.id);

    if (!row) {
        row = { element: createProductRow(product.id), signature: null };
        productRows.set(product.id, row);
    }

    const signature = productSignature(product);

    if (row.signature !== signature) {
        updateProductRow(row.element, product);
        row.signature = signature;
    }

    refreshProductSelects();

    // Re-apply the search so a product arriving over realtime while a
    // search is active is hidden if it does not match, just like the
    // rows already on screen.
    applyProductSearch();

    // appendChild moves an existing node, so an unchanged row keeps its <img>
    document.getElementById("tableBody").appendChild(row.element);
}

function removeProductRow(productId) {
    const row = productRows.get(productId);

    if (!row) {
        return;
    }

    row.element.remove();
    productRows.delete(productId);

    // Drop it from the slide pickers too, so a new slide cannot link to it
    productCatalog.delete(productId);
    refreshProductSelects();
}

// Cheap change detector: only touch cells when a rendered value actually differs
function productSignature(product) {
    return JSON.stringify([
        product.name || "",
        product.price ?? "",
        // Stock is in the list because place_order() changes it, and the
        // row has to repaint the moment that lands.
        product.stock ?? "",
        product.description || "",
        product.category || "",
        product.image_url || ""
    ]);
}

function createProductRow(productId) {
    const row = document.createElement("tr");
    row.dataset.productId = productId;
    row.innerHTML = `
        <td class="image-cell"></td>
        <td class="name-cell"></td>
        <td class="price-cell"></td>
        <td class="stock-cell"></td>
        <td class="description-cell"></td>
        <td class="actions-cell">
            <button type="button" class="btn btn-sm btn-outline-primary" data-action="edit">Edit</button>
            <button type="button" class="btn btn-sm btn-danger" data-action="delete">Remove</button>
        </td>
    `;

    // Event delegation on the row, so buttons survive repeated renders
    row.querySelector('[data-action="edit"]').addEventListener("click", () => editProduct(productId));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteProduct(productId));

    return row;
}

function updateProductRow(row, product) {
    const imageCell = row.querySelector(".image-cell");
    const imageUrl = product.image_url || "";

    // Guarded separately so an unchanged image keeps its loaded <img>
    if (imageCell.dataset.imageUrl !== imageUrl) {
        imageCell.dataset.imageUrl = imageUrl;
        imageCell.innerHTML = renderProductImage(imageUrl);
    }

    // textContent keeps product names from injecting markup into the table.
    // The category badge is built the same way, so the "&" in
    // "Serums & Treatments" cannot be read as markup either.
    const nameCell = row.querySelector(".name-cell");
    nameCell.textContent = product.name || "";

    const staleBadge = nameCell.querySelector(".category-badge");
    if (staleBadge) staleBadge.remove();

    if (product.category) {
        const badge = document.createElement("span");
        badge.className = "category-badge badge bg-primary-soft text-primary mt-1 d-block";
        badge.textContent = product.category;
        nameCell.appendChild(badge);
    }
    row.querySelector(".price-cell").textContent = formatPrice(product.price);

    // Restocked and sold through both land here over realtime, so the
    // figure on screen is the one the storefront is reading.
    const stockCell = row.querySelector(".stock-cell");

    stockCell.textContent = formatStock(product.stock);
    stockCell.className = "stock-cell"
        + (Number(product.stock) <= 0 ? " stock-out" : "")
        + (Number(product.stock) > 0 && Number(product.stock) <= LOW_STOCK ? " stock-low" : "");

    row.querySelector(".description-cell").textContent = product.description || "";
}

// The placeholder sits underneath so a broken link falls back to it without
// needing to rewrite the markup
function renderProductImage(imageUrl) {
    // image_url is admin-typed text, so escape it before it lands in an attribute
    const safeUrl = escapeAttribute(imageUrl);

    const image = imageUrl
        ? `<img class="product-thumb" src="${safeUrl}" alt="Product image" loading="lazy"
               onerror="this.style.display='none'">`
        : "";

    return `<div class="product-thumb-wrap">${image}<div class="product-thumb-fallback">No image</div></div>`;
}

function escapeAttribute(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/"/g, "&quot;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// For text that lands between tags (e.g. <option> labels). Attribute escaping
// alone would leave a bare & or < looking like markup to the parser.
function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}


// 5. Create Data (Write)
async function addProduct() {
    const nameInput = document.getElementById("name");
    const priceInput = document.getElementById("price");
    const stockInput = document.getElementById("stock");
    const descriptionInput = document.getElementById("description");
    const categoryInput = document.getElementById("productCategory");
    const imageFileInput = document.getElementById("imageFile");
    const imageUrlInput = document.getElementById("imageUrl");
    const addMessage = document.getElementById("addMessage");

    const nameVal = nameInput.value.trim();
    const priceVal = parsePrice(priceInput.value);
    const stockVal = parseStock(stockInput.value);
    const descriptionVal = descriptionInput.value.trim();
    const imageUrlVal = imageUrlInput.value.trim();

    if (nameVal === "") {
        addMessage.textContent = "Please enter a product name.";
        return;
    }

    if (priceVal === null) {
        addMessage.textContent = "Please enter a valid price of zero or more.";
        return;
    }

    if (stockVal === null) {
        addMessage.textContent = "Please enter a stock count of zero or more.";
        return;
    }

    addMessage.textContent = "";

    const fileError = imageFileInput.files[0] ? validateImageFile(imageFileInput.files[0]) : null;

    if (fileError) {
        addMessage.textContent = fileError;
        return;
    }

    const urlError = validateImageUrl(imageUrlVal);

    if (urlError) {
        addMessage.textContent = urlError;
        return;
    }

    setBusy("addButton", "Saving...", "Add Product to Catalog", true);

    try {
        // Upload first, so a product row never points at a missing file
        const imageUrl = await resolveImageInput(
            imageFileInput,
            imageUrlInput,
            (text) => showProgress("add", text)
        );

        const { error } = await withTimeout(
            supabase.from("products").insert({
                name: nameVal,
                price: priceVal,
                stock: stockVal,
                description: descriptionVal,
                category: categoryInput.value || null,
                image_url: imageUrl
            }),
            SAVE_TIMEOUT_MS,
            "Saving the product timed out. Please try again."
        );

        if (error) {
            // Don't strand an uploaded file if the insert was rejected
            await deleteStoredImage(imageUrl);
            throw error;
        }

        // Clear inputs after a confirmed write
        nameInput.value = "";
        priceInput.value = "";
        stockInput.value = "0";
        descriptionInput.value = "";
        categoryInput.value = "";
        imageFileInput.value = "";
        imageUrlInput.value = "";
        showImagePreview("add", null);
        updateDescriptionCount();
    } catch (error) {
        console.error("Add product failed:", error);
        addMessage.textContent = describeError(error, "Unable to add the product.");
    } finally {
        // Always re-enable, so a stalled upload can't lock the form
        setBusy("addButton", "Saving...", "Add Product to Catalog", false);
        hideProgress("add");
    }
}


// 6. Update Data (Edit)
function editProduct(productId) {
    supabase
        .from("products")
        .select("*")
        .eq("id", productId)
        .single()
        .then(({ data, error }) => {
            if (error || !data) {
                console.error("Unable to load the product:", error);
                alert("Unable to load the product.");
                return;
            }

            editingProductId = productId;
            editingImageUrl = data.image_url || null;
            // Snapshot the stock so saveProduct can tell whether the
            // admin actually edited it (see the stock comment up top).
            editingStockAtOpen = data.stock ?? 0;
            document.getElementById("editName").value = data.name || "";
            document.getElementById("editPrice").value = data.price ?? "";
            document.getElementById("editStock").value = data.stock ?? 0;
            document.getElementById("editCategory").value = data.category || "";
            document.getElementById("editDescription").value = data.description || "";
            document.getElementById("editImageFile").value = "";
            document.getElementById("editImageUrl").value = editingImageUrl || "";
            document.getElementById("removeImageCheck").checked = false;
            document.getElementById("editMessage").textContent = "";
            updateEditDescriptionCount();
            showImagePreview("edit", editingImageUrl);

            editModalInstance = bootstrap.Modal.getOrCreateInstance(document.getElementById("editModal"));
            editModalInstance.show();
        })
        .catch((error) => {
            // Network-level failure, or the request was rejected outright
            console.error("Unable to load the product:", error);
            alert("Unable to reach Supabase. Check your connection and try again.");
        });
}

async function saveProduct() {
    if (editingProductId === null) {
        return;
    }

    const productId = editingProductId;
    const editImageFileInput = document.getElementById("editImageFile");
    const editImageUrlInput = document.getElementById("editImageUrl");
    const nameVal = document.getElementById("editName").value.trim();
    const priceVal = parsePrice(document.getElementById("editPrice").value);
    const stockVal = parseStock(document.getElementById("editStock").value);
    const descriptionVal = document.getElementById("editDescription").value.trim();
    const categoryVal = document.getElementById("editCategory").value || null;
    const imageUrlVal = editImageUrlInput.value.trim();
    const editMessage = document.getElementById("editMessage");

    editMessage.textContent = "";

    if (nameVal === "") {
        editMessage.textContent = "Please enter a product name.";
        return;
    }

    if (priceVal === null) {
        editMessage.textContent = "Please enter a valid price of zero or more.";
        return;
    }

    if (stockVal === null) {
        editMessage.textContent = "Please enter a stock count of zero or more.";
        return;
    }

    const fileError = editImageFileInput.files[0] ? validateImageFile(editImageFileInput.files[0]) : null;

    if (fileError) {
        editMessage.textContent = fileError;
        return;
    }

    const urlError = validateImageUrl(imageUrlVal);

    if (urlError) {
        editMessage.textContent = urlError;
        return;
    }

    const removeCurrentImage = document.getElementById("removeImageCheck").checked;
    const previousImageUrl = editingImageUrl;

    setBusy("saveButton", "Saving...", "Save Changes", true);

    try {
        const uploadedImageUrl = await resolveImageInput(
            editImageFileInput,
            editImageUrlInput,
            (text) => showProgress("edit", text)
        );

        // "Remove current image" wins unless a replacement was supplied
        const imageUrl = removeCurrentImage ? null : (uploadedImageUrl ?? previousImageUrl);

        // Only send `stock` when the admin actually changed the box.
        // `place_order()` lowers stock server-side, so a modal left open
        // across a sale holds a stale figure; writing it back blindly
        // resurrected units that were already sold. Leaving stock out of
        // the payload unless it was edited keeps a concurrent sale intact
        // while still allowing a deliberate restock.
        const payload = {
            name: nameVal,
            price: priceVal,
            description: descriptionVal,
            category: categoryVal,
            image_url: imageUrl
        };

        if (editingStockAtOpen === null || stockVal !== editingStockAtOpen) {
            payload.stock = stockVal;
        }

        const { error } = await withTimeout(
            supabase.from("products").update(payload).eq("id", productId),
            SAVE_TIMEOUT_MS,
            "Saving the changes timed out. Please try again."
        );

        if (error) {
            // Don't strand a newly uploaded file if the update was rejected
            await deleteStoredImage(uploadedImageUrl);
            throw error;
        }

        // Clean up the old file only once the new reference is safely stored
        if (previousImageUrl && previousImageUrl !== imageUrl) {
            await deleteStoredImage(previousImageUrl);
        }

        editingProductId = null;
        editingImageUrl = null;
        editingStockAtOpen = null;
        editModalInstance.hide();
    } catch (error) {
        console.error("Product update failed:", error);
        editMessage.textContent = describeError(error, "Unable to save the changes. Please try again.");
    } finally {
        setBusy("saveButton", "Saving...", "Save Changes", false);
        hideProgress("edit");
    }
}


async function deleteProduct(productId) {
    if (!confirm("Remove this product and its uploaded image?")) {
        return;
    }

    // Read first: the row (and its image_url) is gone once deleted
    const { data: product } = await supabase
        .from("products")
        .select("image_url")
        .eq("id", productId)
        .single();

    // featured_slides.product_id is ON DELETE CASCADE, so deleting the
    // product also deletes every slide that linked to it. Read their ids
    // and banner URLs up front, while they still exist: the ids let the
    // rows be dropped locally below, and the URLs let the files be freed
    // too -- otherwise each cascade-deleted slide left its banner
    // orphaned in the bucket forever.
    const { data: linkedSlides } = await supabase
        .from("featured_slides")
        .select("id, banner_url")
        .eq("product_id", productId);

    try {
        const { error } = await withTimeout(
            supabase.from("products").delete().eq("id", productId),
            SAVE_TIMEOUT_MS,
            "Removing the product timed out. Please try again."
        );

        if (error) {
            throw error;
        }

        // Drop the rows locally instead of waiting on the realtime event.
        // If the socket is disconnected or the event is slow, the deleted
        // product (and its cascade-deleted slides) would otherwise linger
        // on screen until the next full reload. Both helpers no-op on an
        // id that is not rendered, so calling them for rows that were
        // never on screen is safe.
        removeProductRow(productId);
        (linkedSlides || []).forEach((slide) => removeSlideRow(slide.id));

        // Free up bucket space. Externally pasted URLs are left alone.
        await deleteStoredImage(product ? product.image_url : null);

        // The rows are already gone via the cascade; this only removes
        // the banner files they pointed at. Done after the delete so a
        // failed product delete never strips a banner from a live slide.
        const bannerUrls = (linkedSlides || [])
            .map((slide) => slide.banner_url)
            .filter(Boolean);

        for (const url of bannerUrls) {
            await deleteStoredImage(url);
        }
    } catch (error) {
        console.error("Product removal failed:", error);
        alert(describeError(error, "Unable to remove the product."));
    }
}


// 7. Live character counters for both description textareas
function updateDescriptionCount() {
    const textarea = document.getElementById("description");
    document.getElementById("descriptionCount").textContent = textarea.value.length;
}

function updateEditDescriptionCount() {
    const textarea = document.getElementById("editDescription");
    document.getElementById("editDescriptionCount").textContent = textarea.value.length;
}


// ---------------------------------------------------------------------------
// 8. Featured slides
//
// One row per carousel slide on the app's home screen. The storefront reads
// only: id, product_id, title, subtitle, description, banner_url,
// item_image_url, item_name, item_price, button_label, is_active,
// display_order.
//
// Three rules shape the code below:
//   * uploads happen before the write, because the row stores the public URLs;
//   * files are only removed after the row that pointed at them is safely
//     replaced or deleted, so nothing live ever references a missing file;
//   * blank fields are legitimate -- the app borrows name, price and photo from
//     the linked product.
// ---------------------------------------------------------------------------

function loadSlides() {
    const tableBody = document.getElementById("slideTableBody");
    tableBody.innerHTML = "";

    // Cleared up front, not only on success: a failed reload must not leave
    // cached entries pointing at rows that are no longer in the document
    slideRows.clear();

    // ascending must be explicit. .order() falls back to newest-first, which
    // would render the carousel backwards against display_order.
    supabase
        .from(SLIDES_TABLE)
        .select("*")
        .order("display_order", { ascending: true })
        .then(({ data, error }) => {
            if (error) {
                console.error("Unable to load featured slides:", error);
                document.getElementById("slideMessage").textContent =
                    describeError(error, "Unable to load the featured slides.");
                return;
            }

            data.forEach(upsertSlideRow);
        });

    subscribeToSlides();
}

function subscribeToSlides() {
    if (slidesChannel) {
        return;
    }

    slidesChannel = supabase
        .channel("featured-slides")
        .on("postgres_changes", { event: "*", schema: "public", table: SLIDES_TABLE }, (payload) => {
            if (payload.eventType === "DELETE") {
                removeSlideRow(payload.old.id);
                return;
            }

            upsertSlideRow(payload.new);
        })
        .subscribe((status) => {
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                console.warn(`Realtime channel status: ${status}`);
            }
        });
}

function unsubscribeFromSlides() {
    if (!slidesChannel) {
        return;
    }

    supabase.removeChannel(slidesChannel);
    slidesChannel = null;
}

function clearSlideRows() {
    slideRows.forEach((row) => row.element.remove());
    slideRows.clear();
    document.getElementById("slideTableBody").innerHTML = "";
}

function upsertSlideRow(slide) {
    if (!slide || !slide.id) {
        return;
    }

    let row = slideRows.get(slide.id);

    if (!row) {
        row = { element: createSlideRow(slide.id), signature: null, slide: null };
        slideRows.set(slide.id, row);
    }

    const signature = slideSignature(slide);

    if (row.signature !== signature) {
        updateSlideRow(row, slide);
        row.signature = signature;
    }

    row.slide = slide;

    // Positioned rather than appended: a realtime payload that changes an order
    // moves the existing node, which also keeps its <img> decoded
    placeSlideRow(row.element, Number(slide.display_order) || 0);
    applySlideSearch();
}

// Inserts before the first row that sorts later. Ties keep their relative order,
// so two slides sharing a display_order stay stable while realtime runs.
function placeSlideRow(element, order) {
    const body = document.getElementById("slideTableBody");
    const next = Array.from(body.children).find((row) => Number(row.dataset.displayOrder) > order);

    if (next) {
        body.insertBefore(element, next);
    } else {
        body.appendChild(element);
    }
}

function removeSlideRow(slideId) {
    const row = slideRows.get(slideId);

    if (!row) {
        return;
    }

    row.element.remove();
    slideRows.delete(slideId);
    applySlideSearch();
}

// Cheap change detector, matching the product table.
//
// Only fields this dashboard still owns are listed. `item_image_url`,
// `item_name`, `item_price` and `description` used to live here; the
// form no longer writes any of them, so a change can only come from the
// SQL editor and does not need repainting the row.
function slideSignature(slide) {
    return JSON.stringify([
        slide.title || "",
        slide.subtitle || "",
        slide.banner_url || "",
        slide.product_id || "",
        slide.is_active ?? false,
        slide.display_order ?? 0
    ]);
}

const CHEVRON_UP = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
const CHEVRON_DOWN = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';

function createSlideRow(slideId) {
    const row = document.createElement("tr");
    row.dataset.slideId = slideId;
    row.innerHTML = `
        <td class="ps-3">
            <input type="number" class="form-control order-cell" data-action="order" step="1" aria-label="Display order">
        </td>
        <td class="preview-cell"></td>
        <td>
            <div class="slide-name-cell"></div>
            <div class="slide-meta-cell"></div>
        </td>
        <td class="status-cell"></td>
        <td class="text-end pe-3 actions-cell">
            <button type="button" class="btn btn-sm btn-outline-light-custom order-btn" data-action="up"
                aria-label="Move slide earlier" title="Move earlier">${CHEVRON_UP}</button>
            <button type="button" class="btn btn-sm btn-outline-light-custom order-btn" data-action="down"
                aria-label="Move slide later" title="Move later">${CHEVRON_DOWN}</button>
            <button type="button" class="btn btn-sm btn-outline-primary" data-action="edit">Edit</button>
            <button type="button" class="btn btn-sm btn-danger" data-action="delete">Remove</button>
        </td>
    `;

    row.querySelector('[data-action="edit"]').addEventListener("click", () => editFeaturedSlide(slideId));
    row.querySelector('[data-action="delete"]').addEventListener("click", () => deleteFeaturedSlide(slideId));
    row.querySelector('[data-action="up"]').addEventListener("click", () => moveSlide(slideId, -1));
    row.querySelector('[data-action="down"]').addEventListener("click", () => moveSlide(slideId, 1));

    // An exact position can be typed straight in, without stepping one at a time
    const orderInput = row.querySelector('[data-action="order"]');
    orderInput.addEventListener("change", () => {
        const next = Number(orderInput.value);

        if (orderInput.value.trim() !== "" && Number.isInteger(next) && next >= INT32_MIN && next <= INT32_MAX) {
            setSlideOrder(slideId, next);
        } else {
            orderInput.value = row.dataset.displayOrder || "0";
        }
    });

    return row;
}

function updateSlideRow(row, slide) {
    const element = row.element;
    const order = Number(slide.display_order) || 0;
    element.dataset.displayOrder = String(order);

    const orderInput = element.querySelector('[data-action="order"]');

    // Never yank the number out from under someone mid-edit
    if (document.activeElement !== orderInput) {
        orderInput.value = String(order);
    }

    // Hidden slides stay listed -- the admin has to be able to find them again
    element.classList.toggle("slide-row-hidden", !slide.is_active);

    const previewCell = element.querySelector(".preview-cell");
    const previewKey = slide.banner_url || "";

    // Guarded separately so an unchanged thumbnail keeps its loaded <img>
    if (previewCell.dataset.previewKey !== previewKey) {
        previewCell.dataset.previewKey = previewKey;
        previewCell.innerHTML = renderSlidePreview(slide);
    }

    // Falls back to the product's name, which is what the app actually
    // renders when a slide has no headline of its own.
    const product = slide.product_id ? productCatalog.get(slide.product_id) : null;

    element.querySelector(".slide-name-cell").textContent =
        slide.title || (product ? product.name : null) || "Untitled slide";

    element.querySelector(".slide-meta-cell").textContent = describeSlideMeta(slide);

    // Takes the cached wrapper, not the element: it re-attaches its listeners
    renderSlideStatus(row, slide);
}

// The app skips a slide with nothing at all to draw, so that state is
// called out here rather than looking like a broken sync later.
// A slide always has a product, so with no banner upload the only thing
// left is the product's own photo.
function isSlideSkippable(slide) {
    if (slide.banner_url) {
        return false;
    }

    const product = slide.product_id ? productCatalog.get(slide.product_id) : null;

    return !product || !product.image_url;
}

// One picture per slide: the banner. The item the banner advertises is
// a real product that carries its own photo, so there is no second
// thumbnail to show.
function renderSlidePreview(slide) {
    return `<div class="slide-preview-set">
                ${slideThumb(slide.banner_url, "slide-shot-banner", "Featured")}
            </div>`;
}

function slideThumb(url, modifier, caption) {
    // The placeholder sits underneath so a broken link falls back to it
    // without needing to rewrite the markup
    const image = url
        ? `<img src="${escapeAttribute(url)}" alt="${caption}" loading="lazy"
               onerror="this.style.display='none'">`
        : "";

    return `<figure class="slide-shot">
                <div class="slide-shot-box ${modifier}">
                    <div class="slide-shot-fallback">${url ? "" : "None"}</div>
                    ${image}
                </div>
                <figcaption>${caption}</figcaption>
            </figure>`;
}

function describeSlideMeta(slide) {
    const parts = [];
    const product = slide.product_id ? productCatalog.get(slide.product_id) : null;

    if (product) {
        parts.push(product.name);
    } else if (slide.product_id) {
        // Only reachable for a slide saved before product_id became
        // required, since deleting a product now cascades the slide away.
        parts.push("Product no longer exists");
    } else {
        parts.push("Missing product");
    }

    // The slide form has no price box, so the row shows what the app
    // will actually use: the product's price. A slide saved before the
    // box was removed may still carry an override, so keep honouring it
    // rather than making old rows look different from what they render.
    const price = slide.item_price ?? (product ? product.price : null);

    if (price !== null && price !== undefined && price !== "") {
        parts.push(formatPrice(price));
    }

    if (slide.subtitle) {
        parts.push(slide.subtitle);
    }

    return parts.join("  •  ");
}

// Re-renders the product-dependent cells of every slide row.
//
// loadProducts() and loadSlides() fire concurrently at sign-in, so a
// slide row can be rendered before its product is in productCatalog --
// its meta line then reads "Product no longer exists" (and its price is
// missing) even though the product is fine. Nothing else re-renders
// those cells, so the wrong label stayed until a manual reload. Called
// once the product query has resolved to correct it.
function refreshSlideProductLabels() {
    slideRows.forEach((row) => {
        const slide = row.slide;

        if (!slide) {
            return;
        }

        const product = slide.product_id ? productCatalog.get(slide.product_id) : null;

        row.element.querySelector(".slide-name-cell").textContent =
            slide.title || (product ? product.name : null) || "Untitled slide";

        row.element.querySelector(".slide-meta-cell").textContent = describeSlideMeta(slide);
    });
}

function renderSlideStatus(row, slide) {
    const cell = row.element.querySelector(".status-cell");

    // Static markup plus a boolean -- no admin-typed text reaches innerHTML
    cell.innerHTML = `
        <div class="form-check form-switch mb-0">
            <input class="form-check-input" type="checkbox" data-action="active"${slide.is_active ? " checked" : ""}
                aria-label="Show this slide in the app">
        </div>
        <div class="form-text">${slide.is_active ? "Live in app" : "Hidden"}</div>
    `;

    if (isSlideSkippable(slide)) {
        const note = document.createElement("div");
        note.className = "form-text fw-semibold mt-1";
        note.style.color = "#b45309";
        note.textContent = "App will skip this";
        note.title = SKIPPABLE_WARNING;
        cell.appendChild(note);
    }

    const toggle = cell.querySelector('[data-action="active"]');
    toggle.addEventListener("change", (event) => toggleSlideActive(slide.id, event.target.checked));
}


// ---------------------------------------------------------------------------
// 8c. Order log
//
// READ ONLY. The database refuses an UPDATE from an admin -- there is
// only a SELECT policy for `is_admin()` -- so this panel can show order
// history but cannot rewrite it.
//
// ESCAPING. Everything on an order row except the numbers and the status
// is customer-typed free text: the name, the email and the delivery
// address. Rendering any of it with innerHTML would let a customer store
// markup that then runs in an admin's browser, so every cell here is
// filled with textContent or through escapeHtml(). The one place markup
// is built uses escapeHtml on each interpolated value.
// ---------------------------------------------------------------------------

function orderShortId(order) {
    return String(order.id || "").slice(0, 8).toUpperCase();
}

function formatOrderDate(value) {
    if (!value) {
        return "--";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return "--";
    }

    return date.toLocaleString("en-PH", {
        year: "numeric",
        month: "short",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true
    });
}

function statusPill(status) {
    const text = String(status || "");
    const modifier = text === "Cancelled" ? "pill-cancelled" : "pill-completed";

    return `<span class="order-pill ${modifier}">${escapeHtml(text)}</span>`;
}

// The items column is a jsonb array the app wrote, but it is still
// untrusted data -- a hand-edited row in the SQL editor could hold
// anything, so it is treated as text rather than trusted to be an array.
function readOrderItems(order) {
    const items = order.items;

    if (Array.isArray(items)) {
        return items;
    }

    if (typeof items === "string") {
        try {
            const parsed = JSON.parse(items);

            return Array.isArray(parsed) ? parsed : [];
        } catch (error) {
            return [];
        }
    }

    return [];
}

function orderSignature(order) {
    return JSON.stringify([
        order.customer_name || "",
        order.customer_email || "",
        order.address || "",
        order.payment_method || "",
        order.status || "",
        Number(order.item_count) || 0,
        String(order.total_amount ?? ""),
        String(order.subtotal_amount ?? ""),
        String(order.delivery_fee ?? ""),
        order.purchase_type || "",
        order.created_at || "",
        JSON.stringify(order.items ?? null)
    ]);
}

function createOrderRow(orderId) {
    const row = document.createElement("tr");
    row.dataset.orderId = orderId;

    // Static skeleton only. Nothing customer-typed reaches innerHTML here.
    row.innerHTML = `
        <td class="ps-3 order-id-cell"></td>
        <td class="order-date-cell"></td>
        <td>
            <div class="order-customer-cell fw-semibold"></div>
            <div class="order-email-cell text-muted small"></div>
        </td>
        <td class="order-items-cell"></td>
        <td class="order-total-cell fw-semibold"></td>
        <td class="order-status-cell"></td>
        <td class="text-end pe-3 actions-cell">
            <button type="button" class="btn btn-sm btn-outline-primary" data-action="view">View</button>
        </td>
    `;

    row.querySelector('[data-action="view"]').addEventListener("click", () => {
        showOrderDetail(orderId);
    });

    return row;
}

function updateOrderRow(row, order) {
    const element = row.element;

    element.querySelector(".order-id-cell").textContent = orderShortId(order);

    // textContent, not innerHTML: the name is whatever the customer typed.
    element.querySelector(".order-customer-cell").textContent =
        order.customer_name || "Unnamed customer";

    // Null on orders placed before the column existed, which the
    // backfill in the schema fixes. Not shown rather than shown as
    // "undefined".
    element.querySelector(".order-email-cell").textContent = order.customer_email || "";

    element.querySelector(".order-date-cell").textContent = formatOrderDate(order.created_at);

    element.querySelector(".order-items-cell").textContent =
        `${Number(order.item_count) || 0} item${Number(order.item_count) === 1 ? "" : "s"}`;

    element.querySelector(".order-total-cell").textContent = formatPrice(order.total_amount);

    element.querySelector(".order-status-cell").innerHTML = statusPill(order.status);

    element.classList.toggle("order-row-cancelled", order.status === "Cancelled");

    row.order = order;
}

function upsertOrderRow(order) {
    if (!order || !order.id) {
        return;
    }

    let row = orderRows.get(order.id);

    if (!row) {
        const element = createOrderRow(order.id);

        // The table reads newest first (loadOrders sorts created_at
        // desc), so a brand new order has to be slotted in by date, not
        // appended. Appending put every live order at the bottom, out of
        // order, until the next full reload.
        insertOrderRowInOrder(element, order);

        row = { element, signature: null, order: null };
        orderRows.set(order.id, row);
    }

    const signature = orderSignature(order);

    if (row.signature !== signature) {
        updateOrderRow(row, order);
        row.signature = signature;
    }

    row.order = order;

    refreshOrderCount();
}

// Places a new order <tr> after every existing row that is newer, so the
// table stays in created_at descending order as live rows arrive.
function insertOrderRowInOrder(element, order) {
    const tableBody = document.getElementById("orderTableBody");
    const incoming = Date.parse(order.created_at || "");

    // A row with an unparseable date goes last, which matches "oldest".
    const incomingTime = Number.isNaN(incoming) ? -Infinity : incoming;

    const existingRows = Array.from(orderRows.values());

    for (const row of existingRows) {
        const existingTime = Date.parse(row.order?.created_at || "");
        const existing = Number.isNaN(existingTime) ? -Infinity : existingTime;

        if (existing < incomingTime) {
            row.element.before(element);
            return;
        }
    }

    // Nothing newer ahead of it, so it is the newest and goes on top.
    tableBody.appendChild(element);
}

function removeOrderRow(orderId) {
    const row = orderRows.get(orderId);

    if (!row) {
        return;
    }

    row.element.remove();
    orderRows.delete(orderId);
    refreshOrderCount();
}

function clearOrderRows() {
    orderRows.forEach((row) => row.element.remove());
    orderRows.clear();
    document.getElementById("orderTableBody").innerHTML = "";
    refreshOrderCount();
}

function refreshOrderCount() {
    const badge = document.getElementById("orderCountBadge");

    if (!badge) {
        return;
    }

    const total = orderRows.size;

    badge.textContent = String(total);
    badge.classList.toggle("d-none", total === 0);
}

function loadOrders() {
    const tableBody = document.getElementById("orderTableBody");
    tableBody.innerHTML = "";

    // Cleared up front, like the products and slides panels: a failed
    // reload must not leave rows on screen that are no longer real.
    orderRows.clear();
    refreshOrderCount();

    document.getElementById("orderMessage").textContent = "";

    supabase
        .from("orders")
        .select("*")
        .order("created_at", { ascending: false })
        .then(({ data, error }) => {
            if (error) {
                console.error("Unable to load orders:", error);

                // 42501 here means the signed-in account is not an admin,
                // which is expected rather than broken. Say so plainly
                // instead of showing a raw policy message.
                const forbidden = String(error.code || "") === "42501";

                document.getElementById("orderMessage").textContent = forbidden
                    ? "This account cannot read the order log. Only admin accounts can."
                    : describeError(error, "Unable to load the orders.");

                return;
            }

            data.forEach(upsertOrderRow);
            applyOrderFilters();
        });

    subscribeToOrders();
}

function subscribeToOrders() {
    if (ordersChannel) {
        return;
    }

    // Supabase applies RLS to postgres_changes, so an admin receives
    // every order while a customer would only receive their own. That is
    // the same rule the SELECT policies express.
    ordersChannel = supabase
        .channel("admin-orders")
        .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "orders" },
            (payload) => {
                if (payload.eventType === "DELETE") {
                    removeOrderRow(payload.old.id);
                    return;
                }

                upsertOrderRow(payload.new);
                applyOrderFilters();
            }
        )
        .subscribe((status) => {
            if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
                console.warn(`Orders channel status: ${status}`);
            }
        });
}

function unsubscribeFromOrders() {
    if (!ordersChannel) {
        return;
    }

    supabase.removeChannel(ordersChannel);
    ordersChannel = null;
}

function showOrderDetail(orderId) {
    const row = orderRows.get(orderId);
    const order = row ? row.order : null;

    if (!order) {
        return;
    }

    // Every one of these is set with textContent. See the escaping note
    // at the top of this section.
    document.getElementById("orderDetailCustomer").textContent =
        order.customer_name || "Unnamed customer";

    document.getElementById("orderDetailEmail").textContent =
        order.customer_email || "No account on file for this order";

    document.getElementById("orderDetailDate").textContent =
        formatOrderDate(order.created_at);

    document.getElementById("orderDetailStatus").innerHTML = statusPill(order.status);

    document.getElementById("orderDetailAddress").textContent = order.address || "--";

    document.getElementById("orderDetailPayment").textContent = order.payment_method || "--";

    document.getElementById("orderDetailPurchaseType").textContent =
        order.purchase_type || "--";

    const itemsBody = document.getElementById("orderDetailItems");
    itemsBody.innerHTML = "";

    const items = readOrderItems(order);

    if (items.length === 0) {
        const empty = document.createElement("tr");

        const cell = document.createElement("td");
        cell.colSpan = 4;
        cell.className = "text-center text-muted py-3";
        cell.textContent = "No items recorded for this order.";

        empty.appendChild(cell);
        itemsBody.appendChild(empty);
    }

    for (const item of items) {
        const quantity = Number(item.quantity) || 0;
        const price = Number(item.price) || 0;
        const subtotal = Number(item.subtotal);

        const tr = document.createElement("tr");

        // name is customer-supplied via the product catalog
        const name = document.createElement("td");
        name.textContent = String(item.name || "Unnamed item");

        const priceCell = document.createElement("td");
        priceCell.className = "text-end";
        priceCell.textContent = formatPrice(price);

        const quantityCell = document.createElement("td");
        quantityCell.className = "text-end";
        quantityCell.textContent = String(quantity);

        const subtotalCell = document.createElement("td");
        subtotalCell.className = "text-end fw-semibold";
        // Older rows may not carry a stored subtotal, so fall back to
        // the arithmetic rather than showing PHP 0.
        subtotalCell.textContent = formatPrice(
            Number.isFinite(subtotal) ? subtotal : price * quantity
        );

        tr.append(name, priceCell, quantityCell, subtotalCell);
        itemsBody.appendChild(tr);
    }

    document.getElementById("orderDetailSubtotal").textContent =
        formatPrice(order.subtotal_amount);

    document.getElementById("orderDetailDelivery").textContent =
        formatPrice(order.delivery_fee);

    document.getElementById("orderDetailTotal").textContent =
        formatPrice(order.total_amount);

    orderModalInstance = bootstrap.Modal.getOrCreateInstance(
        document.getElementById("orderModal")
    );
    orderModalInstance.show();
}

// Search and status filter, applied by hiding rows rather than
// re-querying. A filtered-out row keeps its element, so switching the
// filter back is instant and does not need the network.
function applyOrderFilters() {
    const query = document.getElementById("orderSearch").value.toLowerCase().trim();
    const status = activeOrderStatus;

    orderRows.forEach((row) => {
        const order = row.order;

        if (!order) {
            row.element.style.display = "none";
            return;
        }

        const matchesStatus = status === "all" || order.status === status;

        const haystack = [
            order.customer_name,
            order.customer_email,
            orderShortId(order),
            order.id
        ]
            .filter(Boolean)
            .join(" ")
            .toLowerCase();

        row.element.style.display = matchesStatus && haystack.includes(query) ? "" : "none";
    });
}


// ---------------------------------------------------------------------------
// 8b. Product pickers
//
// Both slide forms draw from the catalog the inventory table is already
// streaming, so linking a product never needs a second query.
// ---------------------------------------------------------------------------

function refreshProductSelects() {
    const products = Array.from(productCatalog.values()).sort((a, b) =>
        String(a.name).localeCompare(String(b.name)) || String(a.id).localeCompare(String(b.id))
    );

    // Rebuilding a <select> mid-interaction closes the dropdown, so only do it
    // when the underlying option set has actually changed
    const signature = JSON.stringify(products.map((product) => [product.id, product.name, String(product.price ?? "")]));

    if (signature === productSelectSignature) {
        return;
    }

    productSelectSignature = signature;

    refreshProductSelect("slideProduct", products);
    refreshProductSelect("slideEditProduct", products);
}

function refreshProductSelect(selectId, products) {
    const select = document.getElementById(selectId);
    const previous = select.value;

    // No "standalone" option. Every slide advertises a real product, so
    // the picker is a required field and there is nothing to opt out of.
    // An empty catalog still needs a placeholder, otherwise the select
    // silently shows the first product while the stored value is empty.
    const options = products.length === 0
        ? ['<option value="">No products yet &mdash; create one first</option>']
        : ['<option value="">Choose a product&hellip;</option>'];

    // A slide can outlive the product it points at only if the slide was
    // saved before this rule existed. Keep a dangling id selectable so
    // the admin can see and repair the link instead of the form quietly
    // resetting it.
    if (previous && !productCatalog.has(previous)) {
        options.push(`<option value="${escapeAttribute(previous)}">Product no longer available &mdash; pick another</option>`);
    }

    products.forEach((product) => {
        options.push(
            `<option value="${escapeAttribute(product.id)}">${escapeHtml(product.name)} &mdash; ${formatPrice(product.price)}</option>`
        );
    });

    select.innerHTML = options.join("");
    select.value = previous;
}

// Spells out what the storefront will borrow, so a blank field reads as
// deliberate rather than forgotten
function renderInheritHint(hintId, selectId) {
    const hint = document.getElementById(hintId);
    const product = productCatalog.get(document.getElementById(selectId).value);

    if (!product) {
        hint.classList.add("d-none");
        hint.textContent = "";
        return;
    }

    // The slide form has no name or price box any more: the app always
    // uses the product's own, so there is nothing for the admin to fill
    // in and nothing to hint about. The photo is the one field the
    // slide can fall back to, and the one a product cannot be assumed
    // to have.
    let text = product.image_url
        ? "The app uses this product's name, price and photo on the slide."
        : "The app uses this product's name and price on the slide.";

    if (!product.image_url) {
        text += " It has no photo, so upload a banner or item image.";
    }

    hint.textContent = text;
    hint.classList.remove("d-none");
}


// ---------------------------------------------------------------------------
// 8c. Slide writes
// ---------------------------------------------------------------------------

function validateOrder(value) {
    if (value.trim() === "") {
        return null;
    }

    const order = Number(value);

    if (!Number.isInteger(order)) {
        return "Display order must be a whole number.";
    }

    if (order < INT32_MIN || order > INT32_MAX) {
        return "Display order is out of range.";
    }

    return null;
}

// Validates every picked file before the first byte is uploaded, so rejecting
// the second pick cannot leave the first one stranded in the bucket
function firstFileError(...files) {
    for (const file of files) {
        if (!file) {
            continue;
        }

        const error = validateImageFile(file);

        if (error) {
            return error;
        }
    }

    return null;
}

// Appends to the carousel, so a new slide lands at the end by default
function nextDisplayOrder() {
    const orders = Array.from(slideRows.values()).map((row) => Number(row.slide?.display_order) || 0);
    return orders.length === 0 ? 0 : Math.max(...orders) + 1;
}

function slideWrite(id) {
    if (slideWrites.has(id)) {
        return false;
    }

    slideWrites.add(id);
    return true;
}

function endSlideWrite(id) {
    slideWrites.delete(id);
}

// Puts the row's number and switch back in line with what the database holds
function syncSlideControls(slideId) {
    const row = slideRows.get(slideId);

    if (!row) {
        return;
    }

    const orderInput = row.element.querySelector('[data-action="order"]');

    if (document.activeElement !== orderInput) {
        orderInput.value = row.element.dataset.displayOrder || "0";
    }

    if (row.slide) {
        renderSlideStatus(row, row.slide);
    }
}

// Reordering is just writing new row numbers. The up/down buttons swap this
// slide with its neighbour, which is what an admin expects from a stepper --
// simply adding 1 would jump past rows in between.
async function moveSlide(slideId, direction) {
    const ordered = Array.from(slideRows.values()).sort(
        (a, b) => (Number(a.element.dataset.displayOrder) || 0) - (Number(b.element.dataset.displayOrder) || 0)
    );

    const index = ordered.findIndex((row) => row.element.dataset.slideId === slideId);

    if (index === -1) {
        return;
    }

    const neighbour = ordered[index + direction];

    // Already at the first or last position
    if (!neighbour) {
        return;
    }

    const orderA = Number(ordered[index].element.dataset.displayOrder) || 0;
    const orderB = Number(neighbour.element.dataset.displayOrder) || 0;

    // Swapping identical numbers would change nothing, so nudge instead
    if (orderA === orderB) {
        await setSlideOrder(slideId, orderA + (direction < 0 ? -1 : 1));
        return;
    }

    await Promise.all([
        setSlideOrder(slideId, orderB),
        setSlideOrder(neighbour.element.dataset.slideId, orderA)
    ]);
}

async function setSlideOrder(slideId, displayOrder) {
    if (!slideWrite(slideId)) {
        syncSlideControls(slideId);
        return;
    }

    try {
        const { error } = await withTimeout(
            supabase.from(SLIDES_TABLE).update({
                display_order: displayOrder,
                updated_at: new Date().toISOString()
            }).eq("id", slideId),
            SAVE_TIMEOUT_MS,
            "Reordering the slide timed out. Please try again."
        );

        if (error) {
            throw error;
        }
    } catch (error) {
        console.error("Reordering the slide failed:", error);
        alert(describeError(error, "Unable to change the slide's position."));
        // Realtime will not have corrected it, so re-read rather than leave a
        // number on screen that the database never accepted
        loadSlides();
    } finally {
        endSlideWrite(slideId);
    }
}

// Hiding keeps both files, so this is the cheap, instantly reversible switch
async function toggleSlideActive(slideId, isActive) {
    if (!slideWrite(slideId)) {
        // A write is already in flight; its realtime echo settles the switch
        syncSlideControls(slideId);
        return;
    }

    try {
        const { error } = await withTimeout(
            supabase.from(SLIDES_TABLE).update({
                is_active: isActive,
                updated_at: new Date().toISOString()
            }).eq("id", slideId),
            SAVE_TIMEOUT_MS,
            "Updating the slide timed out. Please try again."
        );

        if (error) {
            throw error;
        }
    } catch (error) {
        console.error("Toggling the slide failed:", error);
        alert(describeError(error, "Unable to change the slide's visibility."));
        syncSlideControls(slideId);
    } finally {
        endSlideWrite(slideId);
    }
}

async function addFeaturedSlide() {
    const bannerFileInput = document.getElementById("slideBannerFile");
    const message = document.getElementById("slideMessage");

    const productId = document.getElementById("slideProduct").value || "";
    const title = document.getElementById("slideTitle").value.trim();
    const subtitle = document.getElementById("slideSubtitle").value.trim();
    const buttonLabel = document.getElementById("slideButtonLabel").value.trim();
    const order = document.getElementById("slideOrder").value.trim();
    const isActive = document.getElementById("slideActive").checked;

    message.textContent = "";

    // A slide is created by promoting an existing product, so the picker
    // is required. Without this the database rejects the insert with a
    // bare not-null violation that says nothing about which field caused
    // it.
    if (!productId) {
        message.textContent = "Choose the product this banner advertises. A featured slide always points at a product, because the Order Now button opens it.";
        return;
    }

    const bannerFile = bannerFileInput.files[0] || null;

    const fileError = firstFileError(bannerFile);

    if (fileError) {
        message.textContent = fileError;
        return;
    }

    const orderError = validateOrder(order);

    if (orderError) {
        message.textContent = orderError;
        return;
    }

    setBusy("slideAddButton", "Saving...", "Add Slide to Carousel", true);

    let uploadedBanner = null;

    try {
        // Upload first, so the row never points at a file that is not there yet
        if (bannerFile) {
            uploadedBanner = await uploadFeaturedImage(
                bannerFile, FEATURED_BANNER_FOLDER, "banner", (text) => showProgress("slide", text)
            );
        }

        const { error } = await withTimeout(
            supabase.from(SLIDES_TABLE).insert({
                product_id: productId,
                title: title || null,
                subtitle: subtitle || null,
                banner_url: uploadedBanner,
                button_label: buttonLabel || DEFAULT_BUTTON_LABEL,
                display_order: order === "" ? nextDisplayOrder() : Number(order),
                is_active: isActive
            }),
            SAVE_TIMEOUT_MS,
            "Saving the slide timed out. Please try again."
        );

        if (error) {
            // Don't strand the uploaded file if the insert was rejected
            await deleteStoredImage(uploadedBanner);
            throw error;
        }

        // Clear the form only after a confirmed write
        resetSlideForm();
    } catch (error) {
        console.error("Adding the featured slide failed:", error);
        message.textContent = describeError(error, "Unable to add the slide. Please try again.");
    } finally {
        // Always re-enable, so a stalled upload can't lock the form
        setBusy("slideAddButton", "Saving...", "Add Slide to Carousel", false);
        hideProgress("slide");
    }
}

function resetSlideForm() {
    document.getElementById("slideProduct").value = "";
    document.getElementById("slideTitle").value = "";
    document.getElementById("slideSubtitle").value = "";
    document.getElementById("slideButtonLabel").value = "";
    document.getElementById("slideActive").checked = true;

    // Realtime may not have delivered the row yet, so seed from what we know
    document.getElementById("slideOrder").value = String(nextDisplayOrder());

    document.getElementById("slideBannerFile").value = "";
    setFilePreview("slideBannerPreview", "slideBannerPreviewImg", null);

    document.getElementById("slideMessage").textContent = "";
    renderInheritHint("slideInheritHint", "slideProduct");
    updateSlideFormWarning();
}

function editFeaturedSlide(slideId) {
    const row = slideRows.get(slideId);

    if (!row || !row.slide) {
        return;
    }

    const slide = row.slide;

    editingSlideId = slideId;
    editingSlideBannerUrl = slide.banner_url || null;

    const select = document.getElementById("slideEditProduct");

    // A dangling product_id has no option of its own until the catalog refreshes
    if (slide.product_id && !select.querySelector(`option[value="${CSS.escape(slide.product_id)}"]`)) {
        const orphan = document.createElement("option");
        orphan.value = slide.product_id;
        orphan.textContent = "Product no longer available";
        select.prepend(orphan);
    }

    select.value = slide.product_id || "";
    document.getElementById("slideEditTitle").value = slide.title || "";
    document.getElementById("slideEditSubtitle").value = slide.subtitle || "";
    document.getElementById("slideEditButtonLabel").value = slide.button_label || "";
    document.getElementById("slideEditOrder").value = String(Number(slide.display_order) || 0);
    document.getElementById("slideEditActive").checked = Boolean(slide.is_active);

    document.getElementById("slideEditBannerFile").value = "";
    document.getElementById("slideEditRemoveBanner").checked = false;
    document.getElementById("slideEditMessage").textContent = "";

    setFilePreview("slideEditBannerPreview", "slideEditBannerPreviewImg", editingSlideBannerUrl);
    renderInheritHint("slideEditInheritHint", "slideEditProduct");
    updateSlideEditWarning();

    slideModalInstance = bootstrap.Modal.getOrCreateInstance(document.getElementById("editSlideModal"));
    slideModalInstance.show();
}

async function saveFeaturedSlide() {
    if (editingSlideId === null) {
        return;
    }

    const slideId = editingSlideId;
    const previousBannerUrl = editingSlideBannerUrl;
    const bannerFileInput = document.getElementById("slideEditBannerFile");
    const message = document.getElementById("slideEditMessage");

    const productId = document.getElementById("slideEditProduct").value || "";
    const title = document.getElementById("slideEditTitle").value.trim();
    const subtitle = document.getElementById("slideEditSubtitle").value.trim();
    const buttonLabel = document.getElementById("slideEditButtonLabel").value.trim();
    const order = document.getElementById("slideEditOrder").value.trim();
    const isActive = document.getElementById("slideEditActive").checked;
    const removeBanner = document.getElementById("slideEditRemoveBanner").checked;

    // An empty order box means "leave it where it is", not "send it to the
    // front" -- clearing the field should never silently reorder a slide
    const cached = slideRows.get(slideId);
    const previousOrder = cached ? Number(cached.element.dataset.displayOrder) || 0 : 0;

    message.textContent = "";

    // Same rule as adding: a slide always points at a product. Guarded
    // here too, because the select can sit on its placeholder while an
    // old row is being repaired.
    if (!productId) {
        message.textContent = "Choose the product this banner advertises.";
        return;
    }

    const bannerFile = bannerFileInput.files[0] || null;

    const fileError = firstFileError(bannerFile);

    if (fileError) {
        message.textContent = fileError;
        return;
    }

    const orderError = validateOrder(order);

    if (orderError) {
        message.textContent = orderError;
        return;
    }

    setBusy("slideSaveButton", "Saving...", "Save Changes", true);

    let uploadedBanner = null;

    try {
        if (bannerFile) {
            uploadedBanner = await uploadFeaturedImage(
                bannerFile, FEATURED_BANNER_FOLDER, "banner", (text) => showProgress("slideEdit", text)
            );
        }

        const { error } = await withTimeout(
            supabase.from(SLIDES_TABLE).update({
                product_id: productId,
                title: title || null,
                subtitle: subtitle || null,
                // "Remove" wins unless a replacement was supplied
                banner_url: removeBanner ? null : (uploadedBanner ?? previousBannerUrl),
                button_label: buttonLabel || DEFAULT_BUTTON_LABEL,
                display_order: order === "" ? previousOrder : Number(order),
                is_active: isActive,
                updated_at: new Date().toISOString()
            }).eq("id", slideId),
            SAVE_TIMEOUT_MS,
            "Saving the slide timed out. Please try again."
        );

        if (error) {
            // Don't strand the newly uploaded file if the update was rejected
            await deleteStoredImage(uploadedBanner);
            throw error;
        }

        // Free the replaced file only once the row no longer points at it
        if (previousBannerUrl && previousBannerUrl !== uploadedBanner) {
            await deleteStoredImage(previousBannerUrl);
        }

        editingSlideId = null;
        editingSlideBannerUrl = null;
        slideModalInstance.hide();
    } catch (error) {
        console.error("Featured slide update failed:", error);
        message.textContent = describeError(error, "Unable to save the changes. Please try again.");
    } finally {
        setBusy("slideSaveButton", "Saving...", "Save Changes", false);
        hideProgress("slideEdit");
    }
}

// Deleting the row alone would leak the banner into the bucket forever, so the
// file goes first. If it cannot be removed the slide is left in place rather
// than left live-but-broken.
async function deleteFeaturedSlide(slideId) {
    const row = slideRows.get(slideId);
    const slide = row ? row.slide : null;
    const label = slide ? (slide.title || "this slide") : "this slide";

    if (!confirm(`Delete "${label}"?\n\nThe product itself stays in the catalog. Only this banner is removed.`)) {
        return;
    }

    // Read the URL before the row goes -- afterwards it is unrecoverable
    const { data: stored, error: readError } = await supabase
        .from(SLIDES_TABLE)
        .select("banner_url")
        .eq("id", slideId)
        .maybeSingle();

    if (readError) {
        console.error("Unable to read the slide before deleting:", readError);
        alert(describeError(readError, "Unable to load the slide."));
        return;
    }

    const path = stored && stored.banner_url ? imagePathFromUrl(stored.banner_url) : null;

    // Delete the row FIRST, then the file. The other way round (which
    // this used to do) meant that if the row delete failed or timed out,
    // the slide stayed live but its banner was already gone -- a broken
    // carousel entry. Removing the file only after the row is really
    // deleted keeps the invariant the rest of this file follows: nothing
    // still referenced by a row ever points at a missing file.
    try {
        const { error } = await withTimeout(
            supabase.from(SLIDES_TABLE).delete().eq("id", slideId),
            SAVE_TIMEOUT_MS,
            "Deleting the slide timed out. Please try again."
        );

        if (error) {
            throw error;
        }

        // Realtime removes the row too, but doing it here keeps the list
        // responsive when the socket is slow
        removeSlideRow(slideId);
    } catch (error) {
        console.error("Featured slide removal failed:", error);
        alert(describeError(error, "Unable to delete the slide."));
        return;
    }

    // Only now, with the row gone, free the banner file.
    if (path) {
        const { error: removeError } = await withTimeout(
            supabase.storage.from(IMAGE_BUCKET).remove([path]),
            UPLOAD_TIMEOUT_MS,
            "The slide was deleted, but removing its banner timed out."
        );

        if (removeError) {
            // The row is already gone, so this only leaves an orphaned
            // file behind -- worth reporting, but not worth failing over.
            console.error("Unable to remove the banner:", removeError);
        }
    }
}


// ---------------------------------------------------------------------------
// 8d. Slide form helpers
// ---------------------------------------------------------------------------

// Object URLs pin the picked file in memory until they are revoked, and these
// previews are rebuilt on every pick
function setFilePreview(previewId, imgId, source) {
    const preview = document.getElementById(previewId);
    const img = document.getElementById(imgId);

    if (img.dataset.objectUrl) {
        URL.revokeObjectURL(img.dataset.objectUrl);
        delete img.dataset.objectUrl;
    }

    if (!source) {
        preview.classList.add("d-none");
        img.removeAttribute("src");
        return;
    }

    if (String(source).startsWith("blob:")) {
        img.dataset.objectUrl = source;
    }

    img.src = source;
    preview.classList.remove("d-none");
}

function setWarning(elementId, show, text) {
    const element = document.getElementById(elementId);
    element.classList.toggle("d-none", !show);
    element.textContent = show ? text : "";
}

const SKIPPABLE_WARNING = "This slide has no images, and its product has no photo either, so the app skips it completely — it will look like it simply never appeared.";

// Every slide points at a product now, so the Order Now button is always
// drawn. There is no standalone case left to warn about.
function slideWarningText(hasOwnPicture, productImageUrl) {
    return hasOwnPicture || productImageUrl ? "" : SKIPPABLE_WARNING;
}

function updateSlideFormWarning() {
    const hasBanner = Boolean(document.getElementById("slideBannerFile").files[0]);

    // With no upload the app borrows the product's photo, so an empty
    // banner box is only a problem when the product has none either.
    const selected = productCatalog.get(document.getElementById("slideProduct").value);
    const productImageUrl = selected ? selected.image_url : null;

    const text = slideWarningText(hasBanner, productImageUrl);

    setWarning("slideWarning", text !== "", text);
}

function updateSlideEditWarning() {
    const removeBanner = document.getElementById("slideEditRemoveBanner").checked;

    const banner = removeBanner
        ? null
        : (document.getElementById("slideEditBannerFile").files[0] || editingSlideBannerUrl);

    const selected = productCatalog.get(document.getElementById("slideEditProduct").value);
    const productImageUrl = selected ? selected.image_url : null;

    const text = slideWarningText(Boolean(banner), productImageUrl);

    setWarning("slideEditWarning", text !== "", text);
}

function applySlideSearch() {
    const query = document.getElementById("slideSearch").value.toLowerCase().trim();

    slideRows.forEach((row) => {
        row.element.style.display = row.element.textContent.toLowerCase().includes(query) ? "" : "none";
    });
}


// ---------------------------------------------------------------------------
// 8e. Wiring
// ---------------------------------------------------------------------------

function switchPanel(panel) {
    document.getElementById("productsPanel").classList.toggle("d-none", panel !== "products");
    document.getElementById("slidesPanel").classList.toggle("d-none", panel !== "slides");
    document.getElementById("ordersPanel").classList.toggle("d-none", panel !== "orders");

    document.querySelectorAll("#dashboardTabs .nav-link").forEach((tab) => {
        const isActive = tab.dataset.panel === panel;
        tab.classList.toggle("active", isActive);
        tab.setAttribute("aria-selected", String(isActive));
    });

    // Opening a hidden panel does not change its layout until something
    // asks for it, so the first paint of the table happens here.
    if (panel === "orders") {
        applyOrderFilters();
    }
}

function clearBannerSelection() {
    document.getElementById("slideBannerFile").value = "";
    setFilePreview("slideBannerPreview", "slideBannerPreviewImg", null);
    updateSlideFormWarning();
}

function initFeaturedSlides() {
    document.querySelectorAll("#dashboardTabs .nav-link").forEach((tab) => {
        tab.addEventListener("click", () => switchPanel(tab.dataset.panel));
    });

    document.getElementById("slideAddButton").addEventListener("click", addFeaturedSlide);
    document.getElementById("slideSaveButton").addEventListener("click", saveFeaturedSlide);
    document.getElementById("slideClearBanner").addEventListener("click", clearBannerSelection);
    document.getElementById("slideSearch").addEventListener("input", applySlideSearch);

    document.getElementById("slideProduct").addEventListener("change", () => {
        renderInheritHint("slideInheritHint", "slideProduct");
        updateSlideFormWarning();
    });

    document.getElementById("slideEditProduct").addEventListener("change", () => {
        renderInheritHint("slideEditInheritHint", "slideEditProduct");
        updateSlideEditWarning();
    });

    // Preview a picked file straight away -- nothing is uploaded until Save
    document.getElementById("slideBannerFile").addEventListener("change", (event) => {
        const file = event.target.files[0];
        const error = file ? validateImageFile(file) : null;

        if (error) {
            event.target.value = "";
            document.getElementById("slideMessage").textContent = error;
            setFilePreview("slideBannerPreview", "slideBannerPreviewImg", null);
            return;
        }

        document.getElementById("slideMessage").textContent = "";
        setFilePreview("slideBannerPreview", "slideBannerPreviewImg", file ? URL.createObjectURL(file) : null);
        updateSlideFormWarning();
    });

    document.getElementById("slideEditBannerFile").addEventListener("change", (event) => {
        const file = event.target.files[0];
        const error = file ? validateImageFile(file) : null;

        if (error) {
            event.target.value = "";
            document.getElementById("slideEditMessage").textContent = error;
            return;
        }

        document.getElementById("slideEditMessage").textContent = "";

        // Picking a replacement cancels "remove", since both cannot be true
        document.getElementById("slideEditRemoveBanner").checked = false;
        setFilePreview("slideEditBannerPreview", "slideEditBannerPreviewImg", file ? URL.createObjectURL(file) : null);
        updateSlideEditWarning();
    });

    // Ticking the box clears the picker so the intent is unambiguous
    document.getElementById("slideEditRemoveBanner").addEventListener("change", (event) => {
        document.getElementById("slideEditBannerFile").value = "";

        if (event.target.checked) {
            setFilePreview("slideEditBannerPreview", "slideEditBannerPreviewImg", null);
        } else {
            setFilePreview("slideEditBannerPreview", "slideEditBannerPreviewImg", editingSlideBannerUrl);
        }

        updateSlideEditWarning();
    });

    // Discard the tracked slide if the modal is dismissed without saving
    document.getElementById("editSlideModal").addEventListener("hidden.bs.modal", () => {
        editingSlideId = null;
        editingSlideBannerUrl = null;
        setBusy("slideSaveButton", "Saving...", "Save Changes", false);
        hideProgress("slideEdit");

        // Give back the file handle the dismissed modal was holding
        setFilePreview("slideEditBannerPreview", "slideEditBannerPreviewImg", null);
    });

    updateSlideFormWarning();
}


// ---------------------------------------------------------------------------
// 9. Wire everything up
// ---------------------------------------------------------------------------
document.addEventListener("DOMContentLoaded", () => {
    const addTextarea = document.getElementById("description");
    addTextarea.addEventListener("input", updateDescriptionCount);
    updateDescriptionCount();

    const editTextarea = document.getElementById("editDescription");
    editTextarea.addEventListener("input", updateEditDescriptionCount);

    const imageUrlInput = document.getElementById("imageUrl");
    const imageFileInput = document.getElementById("imageFile");
    const editImageUrlInput = document.getElementById("editImageUrl");
    const editImageFileInput = document.getElementById("editImageFile");
    const addMessage = document.getElementById("addMessage");

    // Build both category selects from CATEGORIES so the dashboard can
    // never drift from the storefront chips or the SQL check constraint.
    for (const selectId of ["productCategory", "editCategory"]) {
        const select = document.getElementById(selectId);

        for (const category of CATEGORIES) {
            const option = document.createElement("option");
            option.value = category;
            option.textContent = category;
            select.appendChild(option);
        }
    }

    document.getElementById("loginForm").addEventListener("submit", handleLogin);
    document.getElementById("logoutButton").addEventListener("click", handleLogout);

    // A session that was demoted in another tab, or directly in SQL,
    // should not keep sitting on the dashboard. Tab focus is the natural
    // moment to re-check: the usual way a role changes is by running SQL
    // in another tab and coming back. 'unknown' (a failed read) leaves
    // the session alone.
    document.addEventListener("visibilitychange", async () => {
        if (document.visibilityState !== "visible" || !activeUserId) {
            return;
        }

        const verdict = await verifyAdminAccess(activeUserId);

        if (verdict === "blocked") {
            await denyDashboardAccess();
        }
    });

    document.getElementById("addButton").addEventListener("click", addProduct);
    document.getElementById("saveButton").addEventListener("click", saveProduct);
    document.getElementById("clearImageButton").addEventListener("click", clearImageSelection);

    // Order log: search and status filter. Both work by hiding rows, so
    // neither needs the network and both apply while the panel is
    // hidden.
    document.getElementById("orderSearch").addEventListener("input", applyOrderFilters);

    document.querySelectorAll("[data-order-filter]").forEach((button) => {
        button.addEventListener("click", () => {
            activeOrderStatus = button.dataset.orderFilter;

            document.querySelectorAll("[data-order-filter]").forEach((other) => {
                const isActive = other === button;
                other.classList.toggle("active", isActive);
                other.setAttribute("aria-pressed", String(isActive));
            });

            applyOrderFilters();
        });
    });

    document.getElementById("orderModal").addEventListener("hidden.bs.modal", () => {
        orderModalInstance = null;
    });

    // Preview the chosen file immediately, before any upload starts
    imageFileInput.addEventListener("change", () => {
        const file = imageFileInput.files[0];

        if (!file) {
            showImagePreview("add", null);
            return;
        }

        const error = validateImageFile(file);

        if (error) {
            imageFileInput.value = "";
            addMessage.textContent = error;
            showImagePreview("add", null);
            return;
        }

        addMessage.textContent = "";
        imageUrlInput.value = "";
        showImagePreview("add", URL.createObjectURL(file));
    });

    editImageFileInput.addEventListener("change", () => {
        const file = editImageFileInput.files[0];

        if (!file) {
            showImagePreview("edit", editingImageUrl);
            return;
        }

        const error = validateImageFile(file);

        if (error) {
            editImageFileInput.value = "";
            document.getElementById("editMessage").textContent = error;
            return;
        }

        document.getElementById("editMessage").textContent = "";
        document.getElementById("removeImageCheck").checked = false;
        editImageUrlInput.value = "";
        showImagePreview("edit", URL.createObjectURL(file));
    });

    // The preview follows the field as you type
    imageUrlInput.addEventListener("input", () => {
        const url = imageUrlInput.value.trim();

        if (url !== "") {
            imageFileInput.value = "";
        }

        // Only preview something we would actually accept
        if (url !== "" && validateImageUrl(url)) {
            showImagePreview("add", null);
            return;
        }

        addMessage.textContent = "";
        showImagePreview("add", url || null);
    });

    editImageUrlInput.addEventListener("input", () => {
        const url = editImageUrlInput.value.trim();

        if (url !== "") {
            editImageFileInput.value = "";
            document.getElementById("removeImageCheck").checked = false;
        }

        if (url !== "" && validateImageUrl(url)) {
            return; // leave the existing preview until the URL is valid
        }

        showImagePreview("edit", url || editingImageUrl || null);
    });

    // Ticking the box clears both inputs so the intent is obvious
    document.getElementById("removeImageCheck").addEventListener("change", (event) => {
        if (event.target.checked) {
            editImageFileInput.value = "";
            editImageUrlInput.value = "";
            showImagePreview("edit", null);
        } else {
            editImageUrlInput.value = editingImageUrl || "";
            showImagePreview("edit", editingImageUrl);
        }
    });

    // Discard the tracked row if the modal is dismissed without saving
    document.getElementById("editModal").addEventListener("hidden.bs.modal", () => {
        editingProductId = null;
        editingImageUrl = null;
        editingStockAtOpen = null;
        setBusy("saveButton", "Saving...", "Save Changes", false);
        hideProgress("edit");
    });

    initFeaturedSlides();
    initAuth();
});
