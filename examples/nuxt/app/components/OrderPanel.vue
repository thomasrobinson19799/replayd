<script setup lang="ts">
const order: { price?: number } = {}
function buy() {
  return order.price!.toFixed(2)
}
</script>
<template><button id="buy" @click="buy">Buy</button></template>
