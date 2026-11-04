<script lang="ts">
  import { page } from '$app/state';
</script>

<h1>Couldn’t open this page</h1>
<p role="alert">{page.error?.message ?? 'Please try again.'}</p>
<a href="/">Back to events</a>
