<script setup lang="ts">
withDefaults(
  defineProps<{
    label: string;
    columns?: { key: string; label: string; sortable?: boolean }[];
    sort?: string;
    direction?: 'ascending' | 'descending';
  }>(),
  { columns: () => [], sort: undefined, direction: 'descending' },
);
defineEmits<{ sort: [string] }>();
function key(e: KeyboardEvent) {
  if ((e.target as HTMLElement).closest("input,select,textarea,[contenteditable=true]")) return;
  if (!["j", "k", "ArrowDown", "ArrowUp"].includes(e.key)) return;
  const rows = [
    ...(e.currentTarget as HTMLElement).querySelectorAll<HTMLElement>(
      "tbody tr[data-row]",
    ),
  ];
  const active = (e.target as HTMLElement).closest("tr") as HTMLElement;
  const next = Math.max(
    0,
    Math.min(
      rows.length - 1,
      rows.indexOf(active) + (e.key === "j" || e.key === "ArrowDown" ? 1 : -1),
    ),
  );
  if (rows[next]) {
    e.preventDefault();
    (rows[next].querySelector<HTMLElement>("a,button") ?? rows[next]).focus();
  }
}
</script>
<template>
  <div class="table-scroll" @keydown="key">
    <table :aria-label="label">
      <thead v-if="columns.length">
        <tr>
          <th
            v-for="c in columns"
            :key="c.key"
            scope="col"
            :aria-sort="
              c.sortable ? (sort === c.key ? direction : 'none') : undefined
            "
          >
            <button v-if="c.sortable" @click="$emit('sort', c.key)">
              {{ c.label }} {{ sort === c.key ? direction === 'ascending' ? '↑' : '↓' : '↕' }}</button
            ><span v-else>{{ c.label }}</span>
          </th>
        </tr>
      </thead>
      <slot />
    </table>
  </div>
</template>
