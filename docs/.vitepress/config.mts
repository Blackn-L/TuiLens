import { defineConfig, type DefaultTheme } from 'vitepress'

const repository = 'https://github.com/Blackn-L/TuiLens'
const base = '/TuiLens/'
const sampleReportPath = `${base}examples/scenario.html`
const chapters = [
  {
    title: ['Get started', '入门'],
    pages: [
      ['GETTING-STARTED', 'Installation and quick start', '安装与快速开始'],
      ['MCP-SETUP', 'MCP client setup', 'MCP 客户端接入'],
    ],
  },
  {
    title: ['Work with terminals', '终端自动化'],
    pages: [
      ['PROTOCOL', 'Protocol examples', '协议示例'],
      ['PROFILES', 'Terminal profiles', '终端能力画像'],
      ['IMAGES', 'Images and screenshots', '图片与截图'],
      ['RECORDING', 'Recording and scenarios', '录制与场景'],
    ],
  },
  {
    title: ['Test and inspect', '测试与分析'],
    pages: [
      ['VISUAL', 'Visual comparisons', '视觉比较'],
      ['PERFORMANCE', 'Performance tests', '性能测试'],
      ['REPORTING', 'Evidence reports', '证据报告'],
      ['VALIDATION', 'Validation', '验证'],
    ],
  },
  {
    title: ['Project', '项目'],
    pages: [
      ['ARCHITECTURE', 'Architecture', '架构'],
      ['ROADMAP', 'Roadmap', '路线图'],
      ['RELEASING', 'Releasing', '发布'],
    ],
  },
]

function sidebar(chinese: boolean): DefaultTheme.SidebarItem[] {
  const groups = chapters.map(({ title, pages }) => ({
    text: title[chinese ? 1 : 0],
    items: pages.map(([page, en, zh]) => ({
      text: chinese ? zh : en,
      link: `${chinese ? '/zh-CN/' : '/'}${page}`,
    })),
  }))
  groups[groups.length - 1].items.push({
    text: chinese ? '贡献说明' : 'Contributing',
    link: `${repository}/blob/main/${chinese ? 'docs/zh-CN/' : ''}CONTRIBUTING.md`,
  })
  return groups
}

export default defineConfig({
  title: 'TuiLens',
  description: 'Automate real terminal applications with MCP, a JSON CLI and a TypeScript SDK.',
  base,
  head: [['link', { rel: 'icon', href: `${base}icon.svg`, type: 'image/svg+xml' }]],
  markdown: {
    config(md) {
      const renderLink = md.renderer.rules.link_open!
      md.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
        const link = tokens[index]
        // The published URL also works on GitHub. Serve the local HTML artifact in site previews.
        if (link.attrGet('href') === `https://blackn-l.github.io${sampleReportPath}`) {
          link.attrSet('href', sampleReportPath)
          link.attrSet('target', '_self')
        }
        return renderLink(tokens, index, options, env, renderer)
      }
    },
  },
  // The repository's English contributor guide lives at its root.
  srcExclude: ['zh-CN/CONTRIBUTING.md'],
  locales: {
    root: {
      label: 'English',
      lang: 'en',
      themeConfig: {
        nav: [
          { text: 'Quick start', link: '/GETTING-STARTED' },
          { text: 'MCP setup', link: '/MCP-SETUP' },
          { text: 'Evidence reports', link: '/REPORTING' },
        ],
        sidebar: sidebar(false),
      },
    },
    'zh-CN': {
      label: '简体中文',
      lang: 'zh-CN',
      description: '通过 MCP、JSON CLI 或 TypeScript SDK 自动操作真实的终端应用。',
      themeConfig: {
        nav: [
          { text: '快速开始', link: '/zh-CN/GETTING-STARTED' },
          { text: 'MCP 接入', link: '/zh-CN/MCP-SETUP' },
          { text: '证据报告', link: '/zh-CN/REPORTING' },
        ],
        sidebar: sidebar(true),
        outline: { label: '本页目录' },
        docFooter: { prev: '上一页', next: '下一页' },
        langMenuLabel: '选择语言',
        sidebarMenuLabel: '菜单',
        returnToTopLabel: '返回顶部',
        darkModeSwitchLabel: '外观',
        lightModeSwitchTitle: '切换至浅色模式',
        darkModeSwitchTitle: '切换至深色模式',
      },
    },
  },
  themeConfig: {
    logo: '/icon.svg',
    socialLinks: [{ icon: 'github', link: repository }],
    search: {
      provider: 'local',
      options: {
        miniSearch: {
          options: {
            // Use the same word boundaries when building the index and querying it in the browser.
            tokenize: (text: string) => Array.from(
              new Intl.Segmenter('zh', { granularity: 'word' }).segment(text),
            ).filter((part) => part.isWordLike).map((part) => part.segment),
          },
        },
        locales: {
          'zh-CN': {
            translations: {
              button: { buttonText: '搜索', buttonAriaLabel: '搜索文档' },
              modal: {
                displayDetails: '显示详细结果',
                resetButtonTitle: '清除搜索',
                backButtonTitle: '关闭搜索',
                noResultsText: '没有找到结果',
                footer: {
                  selectText: '选择', selectKeyAriaLabel: '回车键',
                  navigateText: '切换', navigateUpKeyAriaLabel: '上方向键',
                  navigateDownKeyAriaLabel: '下方向键', closeText: '关闭', closeKeyAriaLabel: '退出键',
                },
              },
            },
          },
        },
      },
    },
  },
})
