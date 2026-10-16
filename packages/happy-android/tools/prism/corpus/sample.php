<?php
namespace App\Models;
// comment
class User extends Model {
    protected $fillable = ['name', "email"];
    public function greet(string $who): string {
        $n = 42 + 0.5;
        return "Hi {$who} " . strtoupper($who);
    }
}
?>
<p><?= htmlspecialchars($user->name) ?></p>
