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
document.addEventListener('DOMContentLoaded', async () => {
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
    populateGallery(room.scene, room.camera, room.renderer, roomContainer, artists, room.onBeforeRender);
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
  artists.forEach(artist => {
    const card = document.createElement('a');
    card.className = 'artist-card';
    card.href = `#artist/${toSlug(artist.name)}`;
    card.innerHTML = `
      <div class="artist-card-accent" style="background:${artist.hex}"></div>
      <div class="artist-card-img-wrap">
        <img class="artist-card-img"
             src="${artist.profilePic}"
             alt="${artist.name}"
             loading="lazy"
             onerror="var r=parseInt(this.dataset.retry||0);if(r<4){this.dataset.retry=r+1;var s=this;setTimeout(function(){s.src=s.src.replace(/[&?]_t=\d+/,'')+'&_t='+Date.now()},(r+1)*800)}else{this.style.display='none'}" />
      </div>
      <div class="artist-card-body">
        <div class="artist-card-name">${artist.name}</div>
        <div class="artist-card-desc">${artist.description}</div>
      </div>
    `;
    grid.appendChild(card);
  });
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
      openArtistPage(artist);
      return;
    }
  }

  // close if open
  page.hidden = true;
  document.body.style.overflow = '';
}

async function openArtistPage(artist) {
  const page = document.getElementById('artist-page');
  const inner = document.getElementById('artist-page-inner');

  let html = `
    <div class="artist-hero" style="--artist-color:${artist.hex}">
      <div class="artist-hero-pic-wrap" id="hero-pic-wrap">
        <img class="artist-hero-pic"
             src="${artist.profilePic}"
             alt="${artist.name}"
             onerror="var r=parseInt(this.dataset.retry||0);if(r<4){this.dataset.retry=r+1;var s=this;setTimeout(function(){s.src=s.src.replace(/[&?]_t=\d+/,'')+'&_t='+Date.now()},(r+1)*800)}else{this.style.display='none'}" />
      </div>
      <div class="artist-hero-info">
        <h1 class="artist-hero-name">${artist.name}</h1>
        <p class="artist-hero-desc">${artist.description}</p>
        <div class="artist-links">
          ${artist.ig ? `<a class="artist-link" href="${artist.ig}" target="_blank" rel="noopener">&#9679; Instagram</a>` : ''}
          ${artist.website ? `<a class="artist-link" href="${ensureProtocol(artist.website)}" target="_blank" rel="noopener">&#9679; Website</a>` : ''}
        </div>
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
        <div class="gallery-loading">Loading gallery&hellip;</div>
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
            ${p.ig ? `<a class="artist-link" href="${p.ig}" target="_blank" rel="noopener">Instagram</a>` : ''}
            ${p.website ? `<a class="artist-link" href="${ensureProtocol(p.website)}" target="_blank" rel="noopener">Website</a>` : ''}
          </div>
          ${renderProjectContent(p.content)}
        </div>
      `;
    });
    html += `</div>`;
  }

  inner.innerHTML = html;
  page.hidden = false;
  page.scrollTop = 0;
  document.body.style.overflow = 'hidden';

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
          <img src="${item.url}" alt="${item.name || 'Gallery image ' + (i + 1)}" loading="lazy"
               onerror="if(!this.dataset.retry){this.dataset.retry='1';this.src=this.src+'&_t='+Date.now()}else{this.parentElement.style.display='none'}" />
        </div>
      `).join('');

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
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    // If lightbox is open, close it and stop — don't also close the artist page
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
    <button class="lb-close">&times;</button>
    ${multi ? `<button class="lb-prev">&lsaquo;</button>` : ''}
    ${multi ? `<button class="lb-next">&rsaquo;</button>` : ''}
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

  // Wait for every image to have a natural height, then place items
  const imgs = items.map(el => el.querySelector('img'));
  const promises = imgs.map(img => {
    if (!img) return Promise.resolve();
    if (img.complete && img.naturalHeight > 0) return Promise.resolve();
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
      return `<img src="${block.data}" alt="${block.title || ''}" style="width:100%;border-radius:8px;margin-top:1rem" />`;
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

function extractYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&?/]+)/);
  return m ? m[1] : null;
}
