<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<title>HaLow Extender Configuration</title>
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<link rel="stylesheet" type="text/css" href="/style.css" />
</head>
<body>
	<form class="content" method="POST" autocomplete="off">

		<h2>HaLow Extender Configuration</h2>

		<p>
			<strong>WARNING:</strong> after saving, your device will
			connect to the SSID specified and no longer have a static IP.
			You will lose access to this device at its current address!
			If your HaLow light does not come on, reset your device
			and check the SSID/password.

		{% if (countries): %}
		<div class="row">
			<label for="country">Country</label>
			<select id="country" name="country" required>
				<option value="" selected disabled>Choose country</option>
				{% for (country in countries): %}
				{% if (country.code != "00"): %}
				<option value="{{ country.code }}">{{ country.country }} ({{ country.code }})</option>
				{% endif %}
				{% endfor %}
			</select>
		</div>
		{% endif %}

		<h3>Client (HaLow)</h3>

		<div class="row">
			<label for="sta_ssid">SSID</label>
			<input id="sta_ssid" name="sta_ssid" type="text" required minlength="1" maxlength="32"
				pattern="^(?:[\x21-\x7E]|[\x21-\x7E][\x20-\x7E]{0,30}[\x21-\x7E])$"
				title="1–32 printable ASCII characters. No leading or trailing spaces."
				value={{ sta.ssid }}>
		</div>

		<div class="row">
			<label for="sta_password">Password</label>
			<input id="sta_password" name="sta_password" type="password" required minlength="8" maxlength="63"
				pattern="^[\x21-\x7E](?:[\x20-\x7E]{6,61})?[\x21-\x7E]$"
				title="8–63 printable ASCII characters. No leading or trailing spaces."
				value={{ sta.password }}>
			<div class="inline">
				<input type="checkbox" id="sta_password-show" />
				<label for="sta_password-show">Show password</label>
			</div>
		</div>

		{% if (ap.exists): %}
		<details>
			<summary>Modify Access Point (2.4 GHz)</summary>

			<div>
				<div class="row inline">
					<input type="checkbox" id="use-client-creds" name="use-client-creds">
					<label for="use-client-creds">Use client SSID/password</label>
				</div>

				<div class="row ap-creds">
					<label for="ap_ssid">SSID</label>
					<input id="ap_ssid" name="ap_ssid" type="text" required minlength="1" maxlength="32"
						pattern="^(?:[\x21-\x7E]|[\x21-\x7E][\x20-\x7E]{0,30}[\x21-\x7E])$"
						title="1–32 printable ASCII characters. No leading or trailing spaces."
						value={{ ap.ssid }}>
				</div>

				<div class="row ap-creds">
					<label for="ap_password">Password</label>
					<input id="ap_password" name="ap_password" type="password" required minlength="8" maxlength="63"
						pattern="^[\x21-\x7E](?:[\x20-\x7E]{6,61})?[\x21-\x7E]$"
						title="8–63 printable ASCII characters. No leading or trailing spaces."
						value="{{ ap.password }}">
					<div class="inline">
						<input type="checkbox" id="ap_password-show" />
						<label for="ap_password-show">Show password</label>
					</div>
				</div>
			</div>
		</details>
		{% endif %}

		<div class="row">
			<button type="submit">Save</button>
		</div>
	</form>

	<form class="content">
		<details>
			<summary>How do I configure this device as a HaLow Access Point?</summary>
			<div style="gap: none;">
				<p>
					This device is currently setup as an Extender (shown by a solid aqua Status LED).
					To switch this device into Access Point mode (shown by a solid green Status LED):
				<ul>
        			<li>hold the mode button until the Status LED starts <strong>slowly flashing green</strong>
					<li>release the button
        			<li>wait until the LED is <strong>solid green</strong>
        			<li>find this device at 192.168.12.1
				</ul>
			</div>
		</details>
	</form>

	<script>
		document.getElementById('sta_password-show').addEventListener('change', (event) => {
			document.getElementById('sta_password').type = event.target.checked ? 'text' : 'password';
		});

		{% if (ap.exists): %}
		document.getElementById('ap_password-show').addEventListener('change', (event) => {
			document.getElementById('ap_password').type = event.target.checked ? 'text' : 'password';
		});

		document.getElementById('use-client-creds').addEventListener('change', (event) => {
			for (const el of document.querySelectorAll('.ap-creds')) {
				el.style.display = event.target.checked ? 'none' : null;
			}
		});
		{% endif %}
	</script>
</body>
</html>
