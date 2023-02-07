// Some random functions, as to not clutter the main file
module.exports = {
	// Input validation
	validateInput: function (input, type) {
		switch (type) {
			case 'extention':
				// Check if input is a 3 digit number
				if (input.length != 3) {
					return false;
				}
				if (isNaN(input)) {
					return false;
				}
				return true;
				break;
		}

	},
	// Generate GraphQL query
	generateQuery: function (type, args) {
		switch (type) {
			case 'lookup':
				return `query {
					fetchExtension(extensionId: "${args.ext}") {
						user {
							extension
							name
							extPassword
							voicemail
						}
					}
					fetchVoiceMail(extensionId: "${args.ext}") {
						password
						email
					}
				}`
				break;
			case 'list':
				return `query {
					fetchAllExtensions {
						extension {
							user {
								extension
								name
								voicemail
							}
						}
					}
				}`;
				break;
			case 'add':
				return `mutation {
					addExtension(input: {
						extensionId: "${args.ext}"
						name: "${args.name}"
						email: "${args.uid}"
						vmEnable: true
						vmPassword: "${args.ext}"
					}) {
						status
					}
				}`;
				break;
			case 'delete':
				return `mutation {
					deleteExtension(input: {extensionId: ${args.ext}}) {
						status
					}
				}`;
				break;
			case 'reload':
				return `mutation {
					doreload(input: {clientMutationId: "${args.id}"}) {
						status
					}
				}`;
				break;
		}
	}
}