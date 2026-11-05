export function useToast() {
  const messages = useState<{ id: number; text: string; tone: string }[]>(
    "toasts",
    () => [],
  );
  function show(text: string, tone = "success") {
    const id = Date.now() + Math.random();
    messages.value = [...messages.value.slice(-3), { id, text, tone }];
    setTimeout(() => {
      messages.value = messages.value.filter((m) => m.id !== id);
    }, 6000);
  }
  return { messages, show };
}
