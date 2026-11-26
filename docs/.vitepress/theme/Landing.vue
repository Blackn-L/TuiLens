<script setup lang="ts">
import { computed } from 'vue'
import { useData, withBase } from 'vitepress'
import screenshot from '../../assets/agent-demo.png'

const { frontmatter, lang } = useData()
const guide = computed(() => withBase(lang.value === 'zh-CN' ? '/zh-CN/GETTING-STARTED.html' : '/GETTING-STARTED.html'))
const sample = withBase('/examples/scenario.html')
</script>

<template>
  <main class="landing">
    <section class="intro" aria-labelledby="home-title">
      <div class="intro-inner">
        <div class="copy">
          <h1 id="home-title">TuiLens</h1>
          <p class="headline">{{ frontmatter.headline }}</p>
          <p class="summary">{{ frontmatter.summary }}</p>
          <div class="actions">
            <a class="primary" :href="guide">{{ frontmatter.start }} <span aria-hidden="true">→</span></a>
            <a class="secondary" :href="sample" target="_self">{{ frontmatter.report }}</a>
          </div>
        </div>
        <figure>
          <img :src="screenshot" :alt="frontmatter.screenshotAlt" fetchpriority="high">
          <figcaption>{{ frontmatter.caption }}</figcaption>
        </figure>
      </div>
    </section>
    <section class="interfaces" aria-labelledby="interfaces-title">
      <h2 id="interfaces-title">{{ frontmatter.interfaces }}</h2>
      <ul>
        <li v-for="entry in frontmatter.routes" :key="entry.id">
          <a :href="guide + '#' + entry.id">
            <span class="route-name">{{ entry.name }} <span class="arrow" aria-hidden="true">→</span></span>
            <span class="route-description">{{ entry.description }}</span>
          </a>
        </li>
      </ul>
    </section>
  </main>
</template>

<style scoped>
.intro {
  background: var(--tl-hero-bg);
  border-bottom: 1px solid var(--vp-c-divider);
}
.intro-inner, .interfaces {
  width: min(100%, 1240px);
  margin-inline: auto;
  padding-inline: clamp(24px, 5vw, 72px);
}
.intro-inner {
  display: grid;
  grid-template-columns: .83fr 1.17fr;
  align-items: center;
  gap: clamp(32px, 5vw, 72px);
  padding-block: clamp(58px, 7vw, 108px);
}
h1 {
  color: var(--tl-title);
  font-size: clamp(54px, 6.6vw, 88px);
  font-weight: 720;
  line-height: 1;
  letter-spacing: -.065em;
}
.headline {
  margin-top: 24px;
  color: var(--tl-title);
  font-size: clamp(23px, 2.45vw, 36px);
  font-weight: 590;
  line-height: 1.18;
  letter-spacing: -.035em;
  text-wrap: balance;
}
.summary, figcaption, .route-description { color: var(--tl-copy); }
.summary {
  max-width: 43ch;
  margin-top: 16px;
  font-size: 17px;
  line-height: 1.6;
}
.actions { display: flex; align-items: center; flex-wrap: wrap; gap: 4px 20px; margin-top: 26px; }
.actions a { display: inline-flex; gap: 12px; align-items: center; min-height: 44px; font-size: 15px; font-weight: 640; }
.primary {
  border-radius: 6px;
  padding: 0 17px;
  background: var(--vp-c-brand-3);
  color: #fff;
}
.primary:hover { background: var(--tl-button-hover); }
.secondary { color: var(--vp-c-brand-1); text-decoration: underline; text-underline-offset: 4px; }
figure { margin: 0; min-width: 0; }
figure img { width: 100%; height: auto; border-radius: 8px; }
figcaption { margin-top: 10px; font-size: 13px; line-height: 1.5; }
.interfaces { padding-block: 40px 56px; }
h2 { font-size: 22px; font-weight: 680; letter-spacing: -.025em; }
ul { list-style: none; display: grid; grid-template-columns: repeat(3, 1fr); margin: 22px 0 0; padding: 0; gap: 28px; }
li { border-top: 1px solid var(--vp-c-divider); }
li a { display: block; padding-block: 16px 10px; }
.route-name { display: flex; align-items: center; justify-content: space-between; color: var(--vp-c-brand-1); font-weight: 680; }
.arrow { transition: transform .18s ease; }
li a:hover .arrow { transform: translateX(3px); }
.route-description { display: block; margin-top: 6px; font-size: 14px; line-height: 1.5; }
@media (max-width: 799px) {
  .intro-inner { grid-template-columns: 1fr; gap: 24px; padding-block: 36px; }
  .headline { margin-top: 16px; }
  .summary { max-width: 52ch; margin-top: 10px; }
  .actions { margin-top: 16px; }
  ul { gap: 16px; }
}
@media (max-width: 600px) {
  .interfaces { padding-block: 28px 40px; }
  ul { grid-template-columns: 1fr; margin-top: 16px; gap: 0; }
  li a { padding-block: 12px; }
}
@media (prefers-reduced-motion: reduce) {
  .arrow { transition: none; }
}
</style>
