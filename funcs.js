// Some random functions, as to not clutter the main file
// Generate GraphQL query
const generateQuery = (type, args) => {
	switch (type) {
		case 'lookup':
			return minifyQuery(`query {
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
			}`);
			break;
		case 'list':
			return minifyQuery(`query {
				fetchAllExtensions {
					extension {
						user {
							extension
							name
						}
					}
				}
			}`);
			break;
		case 'add':
			return minifyQuery(`mutation {
				addExtension(input: {
					extensionId: "${args.ext}"
					name: "${args.name}"
					email: "${args.uid}"
					vmEnable: true
					vmPassword: "${args.ext}"
					maxContacts: "5"
					umEnable: false
				}) {
					status
				}
			}`);
			break;

		case 'delete':
			return minifyQuery(`mutation {
				deleteExtension(input: {extensionId: ${args.ext}}) {
					status
				}
			}`);
			break;
		case 'reload':
			return minifyQuery(`mutation {
				doreload(input: {clientMutationId: "${args.id}"}) {
					status
				}
			}`);
			break;
		case 'update_name':
			return minifyQuery(`mutation {
				updateCoreUser (input: {extension: ${args.ext}, name: "${args.name}", noanswer_cid: "", busy_cid: "", chanunavail_cid: "", busy_dest: "", noanswer_dest: "", chanunavail_dest: ""}) {
					coreuser {
						name
					}
				}
			}`);
	}
}

// minify query function
const minifyQuery = (query) => {
	return query.replace(/\s+/g, ' ').trim();
}

module.exports = {
	generateQuery,
	minifyQuery,
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
}
