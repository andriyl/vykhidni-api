import neo from 'neostandard'

export default [
	...neo({
		ts: true
	}),
	{
		// Globals, які використовуються всередині page.evaluate() у Chromium.
		languageOptions: {
			globals: {
				CSS: 'readonly',
				location: 'readonly'
			}
		},
		rules: {
			'@stylistic/comma-dangle': ['error', {
				arrays: 'never',
				objects: 'never',
				imports: 'never',
				exports: 'never',
				functions: 'never'
			}]
		}
	}
]
