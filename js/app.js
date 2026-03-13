/**
 * app.js — Main entry point for the Romites site.
 * Fetches data from Google Sheets, renders the artist grid,
 * handles artist detail routing, and initialises the Three.js room.
 */

import { fetchSiteData, fetchArtists, toSlug, driveToPDFEmbed, fetchDriveFolderImages, getDriveFolderId } from './data.js';
import { initRoom } from './room.js';
import { populateGallery } from './gallery3d.js';

/* ================================================================
   INIT
   ================================================================ */
// Prevent browser scroll restoration
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';

document.addEventListener('DOMContentLoaded', async () => {
  // Start at top unless deep-linking to an artist
  if (!location.hash.startsWith('#artist/')) window.scrollTo(0, 0);

  // 1. Kick off Three.js room immediately (doesn't need data)
  const roomContainer = document.getElementById('room-canvas-container');
  let room = null;
  if (roomContainer) {
    room = initRoom(roomContainer);
  }

  // 2. Fetch data in parallel
  const [siteData, artists] = await Promise.all([
    fetchSiteData().catch(() => null),
    fetchArtists().catch(() => []),
  ]);

  // 3. Populate site-wide copy
  if (siteData) {
    if (siteData['Footer Link 1 Title'] && siteData['Footer Link 1 URL']) {
      const footerLinks = document.getElementById('footer-links');
      const a = document.createElement('a');
      a.href = ensureProtocol(siteData['Footer Link 1 URL']);
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = siteData['Footer Link 1 Title'];
      footerLinks.appendChild(a);
    }
  }

  // 4. Populate 3D room with artist avatars
  if (room && artists.length > 0) {
    populateGallery(room.scene, room.camera, room.renderer, roomContainer, artists, room.onBeforeRender, room.focusTarget);
  } else {
    // No artists — hide room loader immediately
    const roomLoader = document.getElementById('room-loader');
    if (roomLoader) {
      roomLoader.classList.add('hidden');
      setTimeout(() => roomLoader.remove(), 600);
    }
  }

  // 5. Render artists
  renderArtistGrid(artists);

  // 5. Check if URL has an artist hash
  handleHash(artists);
  window.addEventListener('hashchange', () => handleHash(artists));
});

/* ================================================================
   ARTIST GRID
   ================================================================ */
function renderArtistGrid(artists) {
  const grid = document.getElementById('artists-grid');
  if (!grid) return;

  if (artists.length === 0) {
    grid.innerHTML = '<div class="loading-placeholder">No artists found.</div>';
    return;
  }

  grid.innerHTML = '';
  artists.forEach((artist, i) => {
    const card = document.createElement('a');
    card.className = 'artist-card';
    card.href = `#artist/${toSlug(artist.name)}`;
    card.innerHTML = `
      <div class="artist-card-accent" style="background:${artist.hex}"></div>
      <div class="artist-card-img-wrap">
        <img class="artist-card-img"
             data-src="${artist.profilePic}"
             data-stagger="${i}"
             alt="${artist.name}" />
      </div>
      <div class="artist-card-body">
        <div class="artist-card-name">${artist.name}</div>
        <div class="artist-card-desc">${artist.description}</div>
      </div>
    `;
    grid.appendChild(card);
  });

  // Lazy-load card images as they enter viewport
  observeLazyImages(grid.querySelectorAll('img[data-src]'));
}

/* ================================================================
   ARTIST DETAIL PAGE
   ================================================================ */
function handleHash(artists) {
  const hash = window.location.hash;
  const page = document.getElementById('artist-page');

  if (hash.startsWith('#artist/')) {
    const slug = hash.replace('#artist/', '');
    const artist = artists.find(a => toSlug(a.name) === slug);
    if (artist) {
      openArtistPage(artist, artists);
      return;
    }
  }

  // close if open
  page.hidden = true;
  document.body.style.overflow = '';
}

async function openArtistPage(artist, artists) {
  const page = document.getElementById('artist-page');
  const inner = document.getElementById('artist-page-inner');

  let html = `
    <div class="artist-hero" style="--artist-color:${artist.hex};--artist-color-dark:${darkenAndBlue(artist.hex)}">
      <div class="artist-hero-row">
        <div class="artist-hero-pic-wrap" id="hero-pic-wrap">
          <img class="artist-hero-pic"
               data-src="${artist.profilePic}"
               alt="${artist.name}" />
        </div>
        <div class="artist-hero-info">
          <h1 class="artist-hero-name">${artist.name}</h1>
          <p class="artist-hero-desc">${artist.description}</p>
        </div>
      </div>
      <div class="artist-links">
        ${artist.ig ? `<a class="artist-link" href="${artist.ig}" target="_blank" rel="noopener">${svgIG}<span class="artist-link-text">${extractIGHandle(artist.ig)}</span></a>` : ''}
        ${artist.website ? `<a class="artist-link" href="${ensureProtocol(artist.website)}" target="_blank" rel="noopener">${svgGlobe}<span class="artist-link-text">${cleanWebURL(artist.website)}</span></a>` : ''}
      </div>
    </div>
  `;

  // YouTube embed
  if (artist.youtubeEmbed) {
    const videoId = extractYouTubeId(artist.youtubeEmbed);
    if (videoId) {
      html += `
        <div class="artist-section-label">Video</div>
        <div class="artist-video">
          <iframe src="https://www.youtube.com/embed/${videoId}"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowfullscreen></iframe>
        </div>
      `;
    }
  }

  // Image Gallery — placeholder that gets populated async
  if (artist.imageGallery) {
    html += `
      <div class="artist-section-label">Gallery</div>
      <div class="artist-gallery" id="artist-gallery">
        <div class="gallery-loading"><span class="section-loader"><span class="section-loader-dot"></span><span class="section-loader-dot"></span><span class="section-loader-dot"></span></span></div>
      </div>
    `;
  }

  // Portfolio PDF embed
  if (artist.portfolioPDF) {
    const pdfEmbedURL = driveToPDFEmbed(artist.portfolioPDF);
    html += `
      <div class="artist-section-label">Portfolio</div>
      <div class="artist-pdf">
        <iframe src="${pdfEmbedURL}"
                allow="autoplay"
                allowfullscreen></iframe>
      </div>
    `;
  }

  // Projects
  if (artist.projects.length > 0) {
    html += `<div class="artist-projects"><div class="artist-section-label">Projects</div>`;
    artist.projects.forEach(p => {
      html += `
        <div class="project-card">
          <div class="project-card-name">${p.name}</div>
          ${p.description ? `<div class="project-card-desc">${p.description}</div>` : ''}
          <div class="project-links">
            ${p.ig ? `<a class="artist-link" href="${p.ig}" target="_blank" rel="noopener">${svgIG} ${extractIGHandle(p.ig)}</a>` : ''}
            ${p.website ? `<a class="artist-link" href="${ensureProtocol(p.website)}" target="_blank" rel="noopener">${svgGlobe} ${cleanWebURL(p.website)}</a>` : ''}
          </div>
          ${renderProjectContent(p.content)}
        </div>
      `;
    });
    html += `</div>`;
  }

  inner.innerHTML = html;

  // --- Prev / Next artist navigation ---
  // Remove old nav cards if present
  page.querySelectorAll('.artist-nav, .artist-nav-label, .artist-nav-bar').forEach(el => el.remove());

  if (artists && artists.length > 1) {
    const idx = artists.findIndex(a => toSlug(a.name) === toSlug(artist.name));
    const len = artists.length;
    const prevArtist = artists[(idx - 1 + len) % len];
    const nextArtist = artists[(idx + 1) % len];
    const prevSlug = toSlug(prevArtist.name);
    const nextSlug = toSlug(nextArtist.name);

    // Desktop: fixed peek-in cards (image only) + separate fixed labels
    const prevCard = document.createElement('a');
    prevCard.className = 'artist-nav artist-nav-prev';
    prevCard.href = `#artist/${prevSlug}`;
    prevCard.style.setProperty('--nav-color', prevArtist.hex);
    prevCard.style.setProperty('--nav-color-dark', darkenAndBlue(prevArtist.hex));
    prevCard.innerHTML = `<img class="artist-nav-img" data-src="${prevArtist.profilePic}" alt="" />`;
    page.appendChild(prevCard);

    const nextCard = document.createElement('a');
    nextCard.className = 'artist-nav artist-nav-next';
    nextCard.href = `#artist/${nextSlug}`;
    nextCard.style.setProperty('--nav-color', nextArtist.hex);
    nextCard.style.setProperty('--nav-color-dark', darkenAndBlue(nextArtist.hex));
    nextCard.innerHTML = `<img class="artist-nav-img" data-src="${nextArtist.profilePic}" alt="" />`;
    page.appendChild(nextCard);

    // Fixed labels (always fully visible, not clipped by card offset)
    const prevLabel = document.createElement('a');
    prevLabel.className = 'artist-nav-label artist-nav-label-prev';
    prevLabel.href = `#artist/${prevSlug}`;
    prevLabel.innerHTML = `<span class="artist-nav-arrow">&larr;</span><span class="artist-nav-name">${prevArtist.name}</span>`;
    page.appendChild(prevLabel);

    const nextLabel = document.createElement('a');
    nextLabel.className = 'artist-nav-label artist-nav-label-next';
    nextLabel.href = `#artist/${nextSlug}`;
    nextLabel.innerHTML = `<span class="artist-nav-name">${nextArtist.name}</span><span class="artist-nav-arrow">&rarr;</span>`;
    page.appendChild(nextLabel);

    // Sync hover: animate label arrow when hovering the card (or vice-versa)
    [[prevCard, prevLabel], [nextCard, nextLabel]].forEach(([card, label]) => {
      let leaveTimer = null;
      for (const el of [card, label]) {
        el.addEventListener('mouseenter', () => {
          clearTimeout(leaveTimer);
          card.classList.add('hovered');
          label.classList.add('hovered');
        });
        el.addEventListener('mouseleave', () => {
          // Small grace period to move between label and card without flicker
          leaveTimer = setTimeout(() => {
            card.classList.remove('hovered');
            label.classList.remove('hovered');
          }, 100);
        });
      }
    });

    // Mobile: inline bottom bar
    const navBar = document.createElement('div');
    navBar.className = 'artist-nav-bar';
    navBar.innerHTML = `
      <a class="artist-nav-bar-item artist-nav-bar-prev" href="#artist/${prevSlug}" style="--nav-color:${prevArtist.hex};--nav-color-dark:${darkenAndBlue(prevArtist.hex)}">
        <div class="artist-nav-bar-text">
          <span class="artist-nav-arrow">&larr;</span>
          <span>${prevArtist.name}</span>
        </div>
        <img class="artist-nav-bar-pic" data-src="${prevArtist.profilePic}" alt="${prevArtist.name}" />
      </a>
      <a class="artist-nav-bar-home" href="#">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
      </a>
      <a class="artist-nav-bar-item artist-nav-bar-next" href="#artist/${nextSlug}" style="--nav-color:${nextArtist.hex};--nav-color-dark:${darkenAndBlue(nextArtist.hex)}">
        <img class="artist-nav-bar-pic" data-src="${nextArtist.profilePic}" alt="${nextArtist.name}" />
        <div class="artist-nav-bar-text">
          <span>${nextArtist.name}</span>
          <span class="artist-nav-arrow">&rarr;</span>
        </div>
      </a>
    `;
    inner.appendChild(navBar);

    // Lazy-load nav card images
    observeLazyImages(page.querySelectorAll('.artist-nav img[data-src]'));
  }

  page.style.setProperty('--artist-color', artist.hex);
  page.style.setProperty('--artist-color-dark', darkenAndBlue(artist.hex));
  page.hidden = false;
  page.scrollTop = 0;
  document.body.style.overflow = 'hidden';
  requestAnimationFrame(() => fitArtistLinks());

  // Dismiss direct-load overlay & ease in content
  const isDirect = document.documentElement.classList.contains('direct-artist');
  const directOverlay = document.getElementById('direct-load-overlay');
  if (isDirect) {
    // Remove class so body becomes visible, but overlay still covers everything
    document.documentElement.classList.remove('direct-artist');
    // Start artist page transparent, then fade in
    page.style.opacity = '0';
    page.style.transition = 'opacity .5s ease';
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        page.style.opacity = '1';
        if (directOverlay) {
          directOverlay.classList.add('hidden');
          setTimeout(() => directOverlay.remove(), 500);
        }
      });
    });
  } else if (directOverlay) {
    directOverlay.classList.add('hidden');
    setTimeout(() => directOverlay.remove(), 400);
  }

  // Block scrolling until images load
  page.style.overflow = 'hidden';
  page.classList.add('loading');

  // Position nav cards centered between hero bottom and viewport bottom
  // Update dynamically as the sticky hero shrinks/expands
  const hero = page.querySelector('.artist-hero');
  if (hero) {
    if (page._heroObserver) page._heroObserver.disconnect();
    page._heroObserver = new ResizeObserver(([entry]) => {
      page.style.setProperty('--hero-h', entry.contentRect.height + 'px');
    });
    page._heroObserver.observe(hero);
  }

  // Lazy-load all deferred images in the detail page (hero pic, project images)
  observeLazyImages(inner.querySelectorAll('img[data-src]'));

  // Scroll unlock — wait for above-the-fold images (hero pic, video thumbnail)
  const scrollBlockStart = Date.now();
  function unlockScroll() {
    const unlock = () => { page.style.overflow = ''; page.classList.remove('loading'); };
    const doUnlock = () => {
      const elapsed = Date.now() - scrollBlockStart;
      if (elapsed < 500) setTimeout(unlock, 500 - elapsed);
      else unlock();
    };
    // Only wait for hero-area images (above the fold)
    const heroImgs = inner.querySelectorAll('.artist-hero img:not(.loaded)');
    if (heroImgs.length === 0) { doUnlock(); return; }
    let done = false;
    const finish = () => { if (done) return; done = true; mo.disconnect(); doUnlock(); };
    const check = () => {
      const remaining = inner.querySelectorAll('.artist-hero img:not(.loaded)');
      if (remaining.length === 0) finish();
    };
    const mo = new MutationObserver(check);
    heroImgs.forEach(img => mo.observe(img, { attributes: true, attributeFilter: ['class'] }));
    check();
    setTimeout(finish, 6000);
  }
  // Start unlock check immediately (hero images load eagerly via observeLazyImages)
  unlockScroll();

  // Init sticky shrinking header
  initStickyArtistHeader();

  // Profile pic → lightbox on click
  const heroPicWrap = document.getElementById('hero-pic-wrap');
  if (heroPicWrap && artist.profilePic) {
    heroPicWrap.addEventListener('click', (e) => {
      e.preventDefault();
      openLightbox([{ url: artist.profilePic, name: artist.name }], 0);
    });
  }

  // Async: fetch gallery images and populate
  if (artist.imageGallery) {
    const galleryEl = document.getElementById('artist-gallery');
    const folderId = getDriveFolderId(artist.imageGallery);
    const galleryItems = await fetchDriveFolderImages(artist.imageGallery);

    if (galleryItems.length > 0) {
      // Render as clickable thumbnails
      galleryEl.innerHTML = galleryItems.map((item, i) => `
        <div class="gallery-item" data-index="${i}">
          <img data-src="${item.url}" data-stagger="${i}" alt="${item.name || 'Gallery image ' + (i + 1)}" />
        </div>
      `).join('');

      // Lazy-load gallery images
      observeLazyImages(galleryEl.querySelectorAll('img[data-src]'));

      // Run masonry layout once all images have loaded
      runMasonry(galleryEl);

      // Lightbox on click
      galleryEl.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const el = e.target.closest('.gallery-item');
        if (!el) return;
        const idx = parseInt(el.dataset.index, 10);
        openLightbox(galleryItems, idx);
      });
    } else if (folderId) {
      // Fallback: embedded Drive folder grid view
      galleryEl.innerHTML = `
        <div class="gallery-fallback">
          <iframe src="https://drive.google.com/embeddedfolderview?id=${folderId}#grid"
                  class="gallery-fallback-iframe"
                  sandbox="allow-scripts allow-same-origin"
                  loading="lazy"></iframe>
        </div>
      `;
    }
  }

}

// Close button
document.getElementById('artist-close').addEventListener('click', () => {
  window.location.hash = '';
});

// ESC key — close lightbox first, then artist page
// Arrow keys — navigate between artists
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    const lb = document.getElementById('lightbox');
    if (lb) {
      lb.remove();
      e.stopImmediatePropagation();
      return;
    }
    const page = document.getElementById('artist-page');
    if (!page.hidden) {
      window.location.hash = '';
    }
  }
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    const page = document.getElementById('artist-page');
    if (page.hidden) return;
    // Don't navigate if lightbox is open
    if (document.getElementById('lightbox')) return;
    const navClass = e.key === 'ArrowLeft' ? '.artist-nav-prev' : '.artist-nav-next';
    const navEl = page.querySelector(navClass);
    if (navEl) {
      window.location.hash = navEl.getAttribute('href');
    }
  }
});

/* ================================================================
   LIGHTBOX
   Items are { url, name } objects.
   ================================================================ */
function openLightbox(items, startIndex) {
  // Remove existing lightbox if any
  const existing = document.getElementById('lightbox');
  if (existing) existing.remove();

  let current = startIndex;
  const multi = items.length > 1;

  // Upsize URL helper — works for Drive thumbnails and passthrough for others
  function fullSize(url) {
    if (url.includes('sz=w')) return url.replace(/sz=w\d+/, 'sz=w1600');
    return url;
  }

  const lb = document.createElement('div');
  lb.id = 'lightbox';
  lb.className = 'lightbox';
  lb.innerHTML = `
    <button class="lb-close"><svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="2" y1="2" x2="16" y2="16"/><line x1="16" y1="2" x2="2" y2="16"/></svg></button>
    ${multi ? `<button class="lb-prev">&larr;</button>` : ''}
    ${multi ? `<button class="lb-next">&rarr;</button>` : ''}
    <div class="lb-content">
      <div class="lb-img-wrap">
        <img class="lb-img" src="${fullSize(items[current].url)}" alt="" />
      </div>
      <div class="lb-caption">${items[current].name || ''}</div>
    </div>
    ${multi ? `<div class="lb-counter">${current + 1} / ${items.length}</div>` : ''}
  `;

  document.body.appendChild(lb);

  const img = lb.querySelector('.lb-img');
  const caption = lb.querySelector('.lb-caption');
  const counter = lb.querySelector('.lb-counter');

  function show(i) {
    current = (i + items.length) % items.length;
    img.src = fullSize(items[current].url);
    caption.textContent = items[current].name || '';
    if (counter) counter.textContent = `${current + 1} / ${items.length}`;
  }

  // Close on X
  lb.querySelector('.lb-close').addEventListener('click', (e) => {
    e.stopPropagation();
    lb.remove();
  });

  // Nav buttons
  const prevBtn = lb.querySelector('.lb-prev');
  const nextBtn = lb.querySelector('.lb-next');
  if (prevBtn) prevBtn.addEventListener('click', (e) => { e.stopPropagation(); show(current - 1); });
  if (nextBtn) nextBtn.addEventListener('click', (e) => { e.stopPropagation(); show(current + 1); });

  // Click backdrop to close (but not the image or caption)
  lb.addEventListener('click', (e) => {
    if (e.target === lb) {
      lb.remove();
    }
  });

  // Arrow keys for nav (ESC handled globally above)
  function onKey(e) {
    if (!document.getElementById('lightbox')) {
      document.removeEventListener('keydown', onKey);
      return;
    }
    if (e.key === 'ArrowLeft') show(current - 1);
    if (e.key === 'ArrowRight') show(current + 1);
  }
  document.addEventListener('keydown', onKey);
}

/* ================================================================
   STICKY ARTIST HEADER — shrink pic on scroll
   ================================================================ */
function initStickyArtistHeader() {
  const page = document.getElementById('artist-page');
  const hero = page.querySelector('.artist-hero');
  if (!hero) return;

  function onScroll() {
    const scrollY = page.scrollTop;
    // Start shrinking after 40px, fully compact by 160px
    const t = Math.min(1, Math.max(0, (scrollY - 40) / 120));
    hero.style.setProperty('--shrink', t);
    if (t > 0) {
      hero.classList.add('is-sticky');
    } else {
      hero.classList.remove('is-sticky');
    }
  }

  page.addEventListener('scroll', onScroll, { passive: true });
  // Reset on open
  onScroll();
}

/* ================================================================
   MASONRY LAYOUT — places gallery items left-to-right into
   the shortest column, Pinterest-style.
   ================================================================ */
function runMasonry(container) {
  const GAP = 12;         // px between items
  const items = [...container.querySelectorAll('.gallery-item')];
  if (items.length === 0) return;

  // Determine number of columns from container width
  const containerW = container.clientWidth;
  const cols = containerW >= 700 ? 3 : containerW >= 400 ? 2 : 1;
  const colW = (containerW - GAP * (cols - 1)) / cols;

  // Track the bottom-edge of each column
  const colHeights = new Array(cols).fill(0);

  // Wait for every image to have a natural height (including lazy-loaded ones), then place items
  const imgs = items.map(el => el.querySelector('img'));
  const promises = imgs.map(img => {
    if (!img) return Promise.resolve();
    // Already loaded with dimensions
    if (img.complete && img.naturalHeight > 0 && img.src) return Promise.resolve();
    // Wait for load or error (covers both lazy-loaded data-src and normal src)
    return new Promise(resolve => {
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    });
  });

  Promise.all(promises).then(() => {
    items.forEach((el, i) => {
      // Find the shortest column
      let shortest = 0;
      for (let c = 1; c < cols; c++) {
        if (colHeights[c] < colHeights[shortest]) shortest = c;
      }

      // Position the item
      const x = shortest * (colW + GAP);
      const y = colHeights[shortest];
      el.style.width = colW + 'px';
      el.style.left = x + 'px';
      el.style.top = y + 'px';

      // Measure its rendered height now that width is set
      const h = el.offsetHeight;
      colHeights[shortest] = y + h + GAP;

      // Reveal
      el.classList.add('placed');
    });

    // Set container height to tallest column
    container.style.height = Math.max(...colHeights) + 'px';
  });
}

// Rebuild masonry on window resize (debounced)
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    const gallery = document.getElementById('artist-gallery');
    if (gallery && gallery.querySelector('.gallery-item.placed')) {
      runMasonry(gallery);
    }
    fitArtistLinks();
  }, 200);
});

/* Check if artist links overflow and collapse to icon-only if needed */
function fitArtistLinks() {
  const container = document.querySelector('.artist-hero .artist-links');
  if (!container) return;
  // Reset first to measure with text
  container.classList.remove('icons-only');
  // Check if any link wraps to a second line
  const links = [...container.querySelectorAll('.artist-link')];
  if (links.length < 2) return;
  const firstTop = links[0].offsetTop;
  const wraps = links.some(l => l.offsetTop > firstTop);
  if (wraps) container.classList.add('icons-only');
}

/* ================================================================
   PROJECT CONTENT — renders content blocks from project tabs.
   Each block has { title, description, type, data }.
   ================================================================ */
function renderProjectContent(content) {
  if (!content || content.length === 0) return '';
  return content.map(block => {
    const type = block.type.toLowerCase();
    if (type === 'video embed' && block.data) {
      const videoId = extractYouTubeId(block.data);
      if (videoId) {
        return `
          <div class="artist-video" style="margin-top:1rem">
            <iframe src="https://www.youtube.com/embed/${videoId}"
                    allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                    allowfullscreen></iframe>
          </div>
        `;
      }
    }
    if (type === 'image' && block.data) {
      return `<img data-src="${block.data}" alt="${block.title || ''}" class="lazy-img" style="width:100%;border-radius:8px;margin-top:1rem;opacity:0;transition:opacity .4s ease" />`;
    }
    if (type === 'pdf' && block.data) {
      const pdfUrl = driveToPDFEmbed(block.data);
      return `
        <div class="artist-pdf" style="margin-top:1rem">
          <iframe src="${pdfUrl}" allow="autoplay" allowfullscreen></iframe>
        </div>
      `;
    }
    return '';
  }).join('');
}

/* ================================================================
   HELPERS
   ================================================================ */
function ensureProtocol(url) {
  if (!url) return '#';
  if (url.startsWith('http://') || url.startsWith('https://')) return url;
  return 'https://' + url;
}

/** Given a hex color, return a darker, more saturated, bluer version */
function darkenAndBlue(hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  let h = 0, s = 0, l = (max + min) / 2;
  if (d) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
    else if (max === g) h = ((b - r) / d + 2) / 6;
    else h = ((r - g) / d + 4) / 6;
  }
  // Slight hue shift toward blue, increase saturation, decrease lightness
  h = h * 360;
  h = h + (240 - h) * 0.12;
  s = Math.min(1, s * 1.5);
  l = Math.max(0.08, l * 0.35);
  // HSL → RGB → hex
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r1, g1, b1;
  if (h < 60)       { r1 = c; g1 = x; b1 = 0; }
  else if (h < 120) { r1 = x; g1 = c; b1 = 0; }
  else if (h < 180) { r1 = 0; g1 = c; b1 = x; }
  else if (h < 240) { r1 = 0; g1 = x; b1 = c; }
  else if (h < 300) { r1 = x; g1 = 0; b1 = c; }
  else              { r1 = c; g1 = 0; b1 = x; }
  const toHex = v => Math.round((v + m) * 255).toString(16).padStart(2, '0');
  return '#' + toHex(r1) + toHex(g1) + toHex(b1);
}

const svgIG = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1 1 12.63 8 4 4 0 0 1 16 11.37z"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5"/></svg>`;

const svgGlobe = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`;

function extractIGHandle(url) {
  if (!url) return '';
  const m = url.match(/instagram\.com\/([^/?#]+)/);
  return m ? '@' + m[1] : url;
}

function cleanWebURL(url) {
  if (!url) return '';
  return url.replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/$/, '');
}

function extractYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&?/]+)/);
  return m ? m[1] : null;
}

/* ================================================================
   LAZY IMAGE LOADER
   Uses IntersectionObserver to defer loading images until they
   enter the viewport, then stagger-loads and fades them in.
   Images use data-src instead of src, and optionally data-stagger
   for staggered delays (150ms per index).
   ================================================================ */
function observeLazyImages(imgs) {
  if (!imgs || imgs.length === 0) return;

  function loadImg(img) {
    const src = img.dataset.src;
    if (!src) return;

    const stagger = parseInt(img.dataset.stagger || '0', 10);
    const delay = stagger * 120;

    setTimeout(() => {
      // Pre-load in a detached Image to avoid showing a broken state
      const loader = new Image();
      loader.onload = () => {
        img.src = src;
        img.classList.add('loaded');
      };
      loader.onerror = () => {
        // Retry up to 3 times with cache-bust
        const retry = parseInt(img.dataset.retry || '0', 10);
        if (retry < 3) {
          img.dataset.retry = retry + 1;
          setTimeout(() => {
            loader.src = src.replace(/[&?]_t=\d+/, '') + (src.includes('?') ? '&' : '?') + '_t=' + Date.now();
          }, (retry + 1) * 800);
        } else {
          img.style.display = 'none';
        }
      };
      loader.src = src;
    }, delay);

    // Remove data-src so observer doesn't re-trigger
    delete img.dataset.src;
  }

  if ('IntersectionObserver' in window) {
    const observer = new IntersectionObserver((entries) => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          loadImg(entry.target);
          observer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '200px' });

    imgs.forEach(img => observer.observe(img));
  } else {
    // Fallback: load all immediately
    imgs.forEach(img => loadImg(img));
  }
}
