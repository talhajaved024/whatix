// Username rule for new and renamed accounts (the server enforces the same):
// 1–64 characters, no spaces anywhere and no capital letters.
export function usernameProblem(value){
  if(!value)return 'Enter a username.';
  if(/\s/u.test(value))return 'Usernames cannot contain spaces.';
  if(value!==value.toLowerCase())return 'Use lowercase letters only. Capital letters are not allowed.';
  if(value.length>64)return 'Use 64 characters or fewer.';
  return '';
}
