<script lang="ts">
  let { returnTo = '/' }: { returnTo?: string } = $props();
  let submitting = $state(false);
</script>

<form method="POST" action="/login" class="login" onsubmit={() => { submitting = true; }}>
  <input type="hidden" name="returnTo" value={returnTo} />
  <label for="handle">Account handle</label>
  <div class="input-row">
    <input id="handle" name="handle" type="text" placeholder="you.example.com" autocomplete="username" required maxlength="253" spellcheck="false" autocapitalize="none" />
    <button class="primary" disabled={submitting}>{submitting ? 'Connecting…' : 'Sign in'}</button>
  </div>
  <p class="muted small">Use an account on a Spaces-enabled PDS.</p>
</form>
