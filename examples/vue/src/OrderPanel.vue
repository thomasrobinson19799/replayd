<script setup>
const order = {};
function buy() {
  return order.price.toFixed(2);
}
</script>
<template><button id="buy" @click="buy">Buy</button></template>
