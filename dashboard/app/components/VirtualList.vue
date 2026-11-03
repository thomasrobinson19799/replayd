<script setup lang="ts" generic="T">
/** Fixed-row-height virtualized list: renders only the visible slice (+ overscan). */
const props = withDefaults(defineProps<{ items: T[], rowHeight?: number, activeIndex?: number, follow?: boolean }>(), {
  rowHeight: 24,
  activeIndex: -1,
  follow: true,
})

const el = ref<HTMLElement | null>(null)
const scrollTop = ref(0)
const height = ref(400)
const OVERSCAN = 10

const start = computed(() => Math.max(0, Math.floor(scrollTop.value / props.rowHeight) - OVERSCAN))
const end = computed(() => Math.min(props.items.length, Math.ceil((scrollTop.value + height.value) / props.rowHeight) + OVERSCAN))
const slice = computed(() => props.items.slice(start.value, end.value).map((item, i) => ({ item, index: start.value + i })))

function onScroll() {
  if (el.value) scrollTop.value = el.value.scrollTop
}

// keep the playhead row in view while playing
watch(() => props.activeIndex, (i) => {
  if (!props.follow || !el.value || i < 0) return
  const top = i * props.rowHeight
  if (top < el.value.scrollTop || top > el.value.scrollTop + height.value - props.rowHeight * 2) {
    el.value.scrollTop = Math.max(0, top - height.value / 2)
  }
})

let ro: ResizeObserver | undefined
onMounted(() => {
  if (!el.value) return
  height.value = el.value.clientHeight
  ro = new ResizeObserver(() => {
    if (el.value) height.value = el.value.clientHeight
  })
  ro.observe(el.value)
})
onBeforeUnmount(() => ro?.disconnect())
</script>

<template>
  <div
    ref="el"
    class="relative h-full overflow-y-auto"
    @scroll.passive="onScroll"
  >
    <div :style="{ height: `${items.length * rowHeight}px` }">
      <div
        v-for="{ item, index } in slice"
        :key="index"
        class="absolute right-0 left-0"
        :style="{ top: `${index * rowHeight}px`, height: `${rowHeight}px` }"
      >
        <slot
          :item="item"
          :index="index"
        />
      </div>
    </div>
  </div>
</template>
