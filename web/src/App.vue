<script setup>
import { store } from './store.js'
import MapView from './views/MapView.vue'
import AskView from './views/AskView.vue'
import GraphView from './views/GraphView.vue'
import DaysView from './views/DaysView.vue'
import SheetHost from './components/SheetHost.vue'
import Lightbox from './components/Lightbox.vue'

const tabs = [
  { id: 'map', label: '地图' },
  { id: 'ask', label: '问山' },
  { id: 'graph', label: '图谱' },
  { id: 'days', label: '日志' },
]
</script>

<template>
  <div class="stage">
    <KeepAlive>
      <MapView v-if="store.tab === 'map'" />
    </KeepAlive>
    <KeepAlive>
      <AskView v-if="store.tab === 'ask'" />
    </KeepAlive>
    <KeepAlive>
      <GraphView v-if="store.tab === 'graph'" />
    </KeepAlive>
    <KeepAlive>
      <DaysView v-if="store.tab === 'days'" />
    </KeepAlive>
  </div>

  <nav class="tabbar" role="tablist" aria-label="视图切换">
    <button v-for="t in tabs" :key="t.id" class="tab" role="tab"
            :class="{ on: store.tab === t.id }"
            :aria-selected="store.tab === t.id"
            @click="store.tab = t.id">
      <svg v-if="t.id === 'map'" viewBox="0 0 24 24" class="ti" aria-hidden="true">
        <path d="M3 19 9 5l4.2 9.2L15.5 10l5.5 9Z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
        <circle cx="17" cy="5.6" r="1.5" fill="currentColor"/>
      </svg>
      <svg v-else-if="t.id === 'ask'" viewBox="0 0 24 24" class="ti" aria-hidden="true">
        <path d="M4 20a8.5 8.5 0 1 1 5.1 1.9L4.5 21z" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/>
        <path d="M8.6 15.5 11 10l1.9 3.9 1-1.6 2.3 3.2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
      </svg>
      <svg v-else-if="t.id === 'graph'" viewBox="0 0 24 24" class="ti" aria-hidden="true">
        <circle cx="6" cy="7" r="2.4" fill="none" stroke="currentColor" stroke-width="1.7"/>
        <circle cx="17.5" cy="5.5" r="1.9" fill="none" stroke="currentColor" stroke-width="1.7"/>
        <circle cx="12" cy="17" r="2.8" fill="none" stroke="currentColor" stroke-width="1.7"/>
        <path d="M8 8.4 10.6 15M15.9 7 13.4 14.6M8.4 7.6l7.2-1.7" stroke="currentColor" stroke-width="1.4"/>
      </svg>
      <svg v-else viewBox="0 0 24 24" class="ti" aria-hidden="true">
        <rect x="5" y="3.5" width="14" height="17" rx="2.2" fill="none" stroke="currentColor" stroke-width="1.7"/>
        <path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4.4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
      </svg>
      <span>{{ t.label }}</span>
    </button>
  </nav>

  <SheetHost />
  <Lightbox />
</template>

<style>
.stage { flex: 1; min-height: 0; position: relative; }
.stage > * { position: absolute; inset: 0; }
.tabbar {
  flex: none; display: flex; z-index: 50;
  background: var(--chip-bg);
  backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px);
  border-top: 1px solid var(--line-soft);
  padding-bottom: env(safe-area-inset-bottom);
}
.tab {
  flex: 1; display: flex; flex-direction: column; align-items: center; gap: 2px;
  padding: 8px 0 7px; font-size: 11px; letter-spacing: .08em;
  color: var(--ink-3); transition: color .15s ease;
}
.tab.on { color: var(--pine); }
.tab .ti { width: 23px; height: 23px; }
</style>
