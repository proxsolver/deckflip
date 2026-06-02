/* ========================================
   복순도가 PPT - Part 1 v2 Script
   ======================================== */

document.addEventListener('DOMContentLoaded', () => {
  const slides = document.querySelectorAll('.slide');
  const progressEl = document.querySelector('.progress-bar .progress');
  const indicatorCurrent = document.querySelector('.slide-indicator .current');
  const indicatorTotal = document.querySelector('.slide-indicator .total');

  if (indicatorTotal) indicatorTotal.textContent = String(slides.length).padStart(2, '0');

  const observer = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      const slide = entry.target;
      if (entry.intersectionRatio >= 0.5) {
        slide.classList.add('in-view');

        const index = Array.from(slides).indexOf(slide);
        const num = index + 1;
        if (indicatorCurrent) indicatorCurrent.textContent = String(num).padStart(2, '0');
        if (progressEl) progressEl.style.width = `${(num / slides.length) * 100}%`;

        if (slide.dataset.chart && !slide.dataset.chartInit) {
          initChart(slide.dataset.chart, slide);
          slide.dataset.chartInit = 'true';
        }

        if (slide.dataset.threeScene && window.boksoonThreeScene) {
          window.boksoonThreeScene.activate();
        }
      } else {
        if (slide.dataset.threeScene && window.boksoonThreeScene) {
          window.boksoonThreeScene.deactivate();
        }
      }
    });
  }, { threshold: [0, 0.5, 1] });

  slides.forEach((slide) => observer.observe(slide));

  let currentIndex = 0;
  const goToSlide = (idx) => {
    if (idx < 0 || idx >= slides.length) return;
    slides[idx].scrollIntoView({ behavior: 'smooth' });
    currentIndex = idx;
  };
  const trackObserver = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (entry.intersectionRatio >= 0.5) {
        currentIndex = Array.from(slides).indexOf(entry.target);
      }
    });
  }, { threshold: 0.5 });
  slides.forEach((slide) => trackObserver.observe(slide));

  document.addEventListener('keydown', (e) => {
    switch (e.key) {
      case 'ArrowDown': case 'ArrowRight': case 'PageDown': case ' ':
        e.preventDefault(); goToSlide(currentIndex + 1); break;
      case 'ArrowUp': case 'ArrowLeft': case 'PageUp':
        e.preventDefault(); goToSlide(currentIndex - 1); break;
      case 'Home': e.preventDefault(); goToSlide(0); break;
      case 'End': e.preventDefault(); goToSlide(slides.length - 1); break;
    }
  });

  // ====== Chart (라이트 모드 톤) ======
  function initChart(chartId, slide) {
    const canvas = slide.querySelector(`canvas#${chartId}`);
    if (!canvas) return;
    const ctx = canvas.getContext('2d');

    if (chartId === 'financeChart') {
      new Chart(ctx, {
        type: 'bar',
        data: {
          labels: ['2017', '2018', '2019', '2020', '2021', '2022', '2023', '2024'],
          datasets: [
            {
              type: 'bar',
              label: '매출액 (억원)',
              data: [10, 15, 20, 28, 35, 45, 58, 70],
              backgroundColor: 'rgba(138, 117, 68, 0.4)',
              borderColor: '#8a7544',
              borderWidth: 1,
              borderRadius: 2,
              order: 2,
            },
            {
              type: 'line',
              label: '전년 대비 성장률 (%)',
              data: [null, 50, 33, 40, 25, 28.5, 28.9, 20.7],
              borderColor: '#1a1a1a',
              backgroundColor: 'rgba(26,26,26,0.05)',
              borderWidth: 2,
              tension: 0.4,
              pointBackgroundColor: '#1a1a1a',
              pointBorderColor: '#FFFFFF',
              pointBorderWidth: 2,
              pointRadius: 5,
              yAxisID: 'y1',
              order: 1,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: { duration: 1800, easing: 'easeOutQuart' },
          plugins: {
            legend: {
              position: 'top', align: 'end',
              labels: {
                color: '#555555',
                font: { family: 'Pretendard', size: 12, weight: '500' },
                padding: 16, boxWidth: 12, usePointStyle: true,
              },
            },
            tooltip: {
              backgroundColor: '#FFFFFF',
              titleColor: '#1a1a1a',
              bodyColor: '#555555',
              borderColor: '#8a7544',
              borderWidth: 1, padding: 12,
              titleFont: { family: 'Pretendard', size: 13, weight: '700' },
              bodyFont: { family: 'Pretendard', size: 12 },
            },
          },
          scales: {
            x: {
              grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false },
              ticks: { color: '#999', font: { family: 'Pretendard', size: 11 } },
            },
            y: {
              grid: { color: 'rgba(0,0,0,0.04)', drawBorder: false },
              ticks: {
                color: '#999',
                font: { family: 'Pretendard', size: 11 },
                callback: (v) => v + ' 억',
              },
            },
            y1: {
              position: 'right',
              grid: { drawOnChartArea: false },
              ticks: {
                color: '#999',
                font: { family: 'Pretendard', size: 11 },
                callback: (v) => v + '%',
              },
            },
          },
        },
      });
    }
  }

  setTimeout(() => slides[0].classList.add('in-view'), 100);
});
